import type {
  Entity,
  Model,
  TemplateParameter,
  Type,
  Value,
} from "@typespec/compiler";
import {
  isArrayModelType,
  isRecordModelType,
  isTemplateDeclaration,
  isTemplateInstance,
  isType,
  isValue,
  walkPropertiesInherited,
} from "@typespec/compiler";
import type { EmitterCtx } from "./ctx.js";
import { scalarToTs } from "./scalar-map.js";
import { tsIdentifier, tsPropertyDeclaration } from "./typescript-names.js";

type TemplateParameterDeclaration = NonNullable<Extract<
  Model["node"],
  { templateParameters: readonly unknown[] }
>["templateParameters"]>[number];

/**
 * Convert a TypeSpec type to a TypeScript type string.
 */
export function typeToTs(ctx: EmitterCtx, type: Type): string {
  switch (type.kind) {
    case "Scalar":
      return scalarToTs(type);

    case "Model": {
      const templateArgs = type.templateMapper?.args ?? [];
      const firstTemplateArg = templateArgs[0];
      if (type.name === "Array" && templateArgs.length === 1 && isType(firstTemplateArg)) {
        return `${typeToTs(ctx, firstTemplateArg)}[]`;
      }
      if (type.name === "Record" && templateArgs.length === 1 && isType(firstTemplateArg)) {
        return `Record<string, ${typeToTs(ctx, firstTemplateArg)}>`;
      }
      if (isArrayModelType(ctx.program, type)) {
        const elementType = type.indexer!.value;
        return `${typeToTs(ctx, elementType)}[]`;
      }
      if (isRecordModelType(ctx.program, type)) {
        const valueType = type.indexer!.value;
        return `Record<string, ${typeToTs(ctx, valueType)}>`;
      }
      // Unwrap HttpPart<T> → T
      if (type.name === "HttpPart" && type.templateMapper?.args) {
        const inner = type.templateMapper.args[0];
        if (inner && isType(inner)) return typeToTs(ctx, inner);
      }
      // Map File and subtypes → Web standard File
      if (isFileModel(type)) {
        return "File";
      }
      if (type.name === "" || type.name === undefined) {
        return emitInlineModel(ctx, type);
      }
      if (isTypeSpecNamespaceModel(type)) {
        return emitInlineModel(ctx, type);
      }
      return modelToTs(ctx, type);
    }

    case "Union": {
      const variants = [...type.variants.values()];
      const parts = variants.map((v) => typeToTs(ctx, v.type));
      return parts.join(" | ");
    }

    case "Enum": {
      const members = [...type.members.values()];
      return members
        .map((m) =>
          typeof m.value === "string"
            ? JSON.stringify(m.value)
            : m.value != null
              ? String(m.value)
              : JSON.stringify(m.name),
        )
        .join(" | ");
    }

    case "EnumMember":
      return enumMemberToTs(type);

    case "String":
      return JSON.stringify(type.value);

    case "Number":
      return String(type.value);

    case "Boolean":
      return String(type.value);

    case "Intrinsic":
      switch (type.name) {
        case "void":
          return "void";
        case "null":
          return "null";
        case "never":
          return "never";
        case "unknown":
          return "unknown";
        default:
          return "unknown";
      }

    case "Tuple":
      return `[${type.values.map((v) => typeToTs(ctx, v)).join(", ")}]`;

    case "UnionVariant":
      return typeToTs(ctx, type.type);

    case "ModelProperty":
      return typeToTs(ctx, type.type);

    case "TemplateParameter":
      return templateParameterToTs(type);

    default:
      return "unknown";
  }
}

export function templateParametersToTs(ctx: EmitterCtx, type: Model): string {
  if (!isTemplateDeclaration(type)) return "";
  const params = getTemplateParameters(type)
    .map((param) => templateParameterDeclarationToTs(ctx, param));
  return params.length > 0 ? `<${params.join(", ")}>` : "";
}

export function isTypeSpecNamespaceModel(model: Model): boolean {
  return model.namespace?.name === "TypeSpec";
}

function modelToTs(ctx: EmitterCtx, model: Model): string {
  const name = tsIdentifier(model.name, "Model");
  if (isTemplateInstance(model)) {
    const args = model.templateMapper.args
      .map((arg) => templateArgumentToTs(ctx, arg));
    return args.length > 0 ? `${name}<${args.join(", ")}>` : name;
  }
  return name;
}

function getTemplateParameters(type: Model): readonly TemplateParameterDeclaration[] {
  const node = type.node;
  if (!node || !("templateParameters" in node)) return [];
  return node.templateParameters;
}

function templateParameterDeclarationToTs(
  ctx: EmitterCtx,
  param: TemplateParameterDeclaration,
): string {
  const name = tsIdentifier(param.id.sv, "T");
  const constraint = param.constraint
    ? templateParameterConstraintToTs(ctx, param.constraint)
    : "";
  const defaultType = param.default
    ? ` = ${typeToTs(ctx, ctx.program.checker.getTypeForNode(param.default))}`
    : "";
  return `${name}${constraint}${defaultType}`;
}

function templateParameterConstraintToTs(
  ctx: EmitterCtx,
  constraint: TemplateParameterDeclaration["constraint"],
): string {
  const constraintTarget = constraint && "target" in constraint && !("arguments" in constraint)
    ? constraint.target
    : constraint;
  if (!constraintTarget) return "";
  const tsType = typeToTs(ctx, ctx.program.checker.getTypeForNode(constraintTarget));
  return tsType === "unknown" ? "" : ` extends ${tsType}`;
}

function templateArgumentToTs(
  ctx: EmitterCtx,
  arg: unknown,
): string {
  if (!isEntityLike(arg)) return "unknown";
  if (isType(arg)) return typeToTs(ctx, arg);
  if (isValue(arg)) return valueToTs(ctx, arg);
  if ("type" in arg && isEntityLike(arg.type) && isType(arg.type)) {
    return typeToTs(ctx, arg.type);
  }
  return "unknown";
}

function templateParameterToTs(type: TemplateParameter): string {
  const node = type.node;
  const name = node && "id" in node ? node.id?.sv : undefined;
  return tsIdentifier(name, "T");
}

function valueToTs(ctx: EmitterCtx, value: Value): string {
  const exactType = ctx.program.checker.getValueExactType(value);
  if (exactType) return typeToTs(ctx, exactType);

  switch (value.valueKind) {
    case "StringValue":
      return JSON.stringify(value.value);
    case "NumericValue":
      return String(value.value);
    case "BooleanValue":
      return String(value.value);
    case "NullValue":
      return "null";
    case "EnumValue":
      return enumMemberToTs(value.value);
    case "ArrayValue":
      return `[${value.values.map((item) => valueToTs(ctx, item)).join(", ")}]`;
    case "ObjectValue":
      return `{ ${[...value.properties.values()]
        .map((prop) => tsPropertyDeclaration(prop.name, valueToTs(ctx, prop.value)))
        .join("; ")} }`;
    default:
      return "unknown";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEntityLike(value: unknown): value is Entity {
  return isObject(value) && "entityKind" in value;
}

function enumMemberToTs(type: { name: string; value?: string | number }): string {
  return typeof type.value === "string"
    ? JSON.stringify(type.value)
    : type.value != null
      ? String(type.value)
      : JSON.stringify(type.name);
}

function isFileModel(model: Model): boolean {
  let current: Model | undefined = model;
  while (current) {
    if (current.name === "File") return true;
    current = current.baseModel;
  }
  return false;
}

function emitInlineModel(ctx: EmitterCtx, model: Model): string {
  const props = [...walkPropertiesInherited(model)].map((prop) => {
    return tsPropertyDeclaration(prop.name, typeToTs(ctx, prop.type), {
      optional: prop.optional,
    });
  });
  return `{ ${props.join("; ")} }`;
}
