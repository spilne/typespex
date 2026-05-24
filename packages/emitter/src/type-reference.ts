import type { Model, TemplateParameter, Type } from "@typespec/compiler";
import {
  isArrayModelType,
  isRecordModelType,
  isTemplateDeclaration,
  isTemplateInstance,
  isType,
} from "@typespec/compiler";
import type { EmitterCtx } from "./ctx.js";
import { scalarToTs } from "./scalar-map.js";
import { tsIdentifier, tsPropertyDeclaration } from "./typescript-names.js";

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

export function templateParametersToTs(type: Model): string {
  if (!isTemplateDeclaration(type)) return "";
  const params = getTemplateParameterNames(type);
  return params.length > 0 ? `<${params.join(", ")}>` : "";
}

function modelToTs(ctx: EmitterCtx, model: Model): string {
  const name = tsIdentifier(model.name, "Model");
  if (isTemplateInstance(model)) {
    const args = model.templateMapper.args
      .map((arg) => isType(arg) ? typeToTs(ctx, arg) : "unknown");
    return args.length > 0 ? `${name}<${args.join(", ")}>` : name;
  }
  return `${name}${templateParametersToTs(model)}`;
}

function getTemplateParameterNames(type: Model): string[] {
  const node = type.node;
  if (!node || !("templateParameters" in node)) return [];
  return node.templateParameters.map((param) => tsIdentifier(param.id.sv, "T"));
}

function templateParameterToTs(type: TemplateParameter): string {
  const node = type.node;
  const name = node && "id" in node ? node.id?.sv : undefined;
  return tsIdentifier(name, "T");
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
  const props = [...model.properties.values()].map((prop) => {
    return tsPropertyDeclaration(prop.name, typeToTs(ctx, prop.type), {
      optional: prop.optional,
    });
  });
  return `{ ${props.join("; ")} }`;
}
