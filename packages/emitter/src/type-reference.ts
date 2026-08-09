import type {
  EnumMember,
  Model,
  Scalar,
  TemplateParameter,
  TemplatedType,
  Type,
  Union,
  Value,
} from "@typespec/compiler";
import {
  isArrayModelType,
  isTemplateDeclaration,
  isTemplateInstance,
  isType,
  isValue,
  walkPropertiesInherited,
} from "@typespec/compiler";
import { SyntaxKind } from "@typespec/compiler/ast";
import {
  getGeneratedTypeName,
  getNamespaceFullName,
  hasGeneratedTypeNameCollision,
  type EmitterCtx,
} from "./ctx.js";
import { getDateTimeMode } from "./datetime-mode.js";
import { getHttpPartType, isHttpFileModel } from "./http-models.js";
import {
  getAdditionalPropertiesValues,
  isNeverAdditionalProperties,
  isPureRecordModel,
} from "./model-indexer.js";
import { scalarToTs } from "./scalar-map.js";
import { isEntityLike } from "./type-guards.js";
import { tsIdentifier, tsPropertyDeclaration } from "./typescript-names.js";
import { enumMemberLiteralExpression, numericLiteralExpression } from "./numeric-literals.js";
import { stringLiteralExpression } from "./string-template-literals.js";

type TemplateParameterDeclaration = NonNullable<
  Extract<TemplatedType["node"], { templateParameters: readonly unknown[] }>["templateParameters"]
>[number];

/**
 * Convert a TypeSpec type to a TypeScript type string.
 */
export function typeToTs(ctx: EmitterCtx, type: Type): string {
  switch (type.kind) {
    case "Scalar":
      if (shouldReferenceScalar(type) || hasGeneratedTypeNameCollision(ctx, type)) {
        return templatedNamedTypeToTs(ctx, type, "Scalar");
      }
      return scalarToTs(type, getDateTimeMode(ctx));

    case "Model": {
      const templateArgs = type.templateMapper?.args ?? [];
      const firstTemplateArg = templateArgs[0];
      // Some compiler-created template instantiations do not expose an indexer,
      // so handle nominal Array<T>/Record<T> before the structural helpers.
      const namespace = getNamespaceFullName(type.namespace);
      if (
        namespace === "TypeSpec" &&
        type.name === "Array" &&
        templateArgs.length === 1 &&
        isType(firstTemplateArg)
      ) {
        return arrayTypeToTs(typeToTs(ctx, firstTemplateArg));
      }
      if (isArrayModelType(ctx.program, type)) {
        const elementType = type.indexer!.value;
        return arrayTypeToTs(typeToTs(ctx, elementType));
      }
      if (isPureRecordModel(type)) {
        const valueTypes = getAdditionalPropertiesValues(type).map((value) => typeToTs(ctx, value));
        return `Record<string, ${valueTypes.join(" | ")}>`;
      }
      // Unwrap the canonical TypeSpec.Http HttpPart<T> to its payload type.
      const httpPartType = getHttpPartType(ctx.program, type);
      if (httpPartType) return typeToTs(ctx, httpPartType);
      // Map File and subtypes → Web standard File
      if (isHttpFileModel(ctx.program, type)) {
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
      if (isNamedUnionReference(type) || hasGeneratedTypeNameCollision(ctx, type)) {
        return templatedNamedTypeToTs(ctx, type, "Union");
      }
      const variants = [...type.variants.values()];
      const parts = variants.map((v) => typeToTs(ctx, v.type));
      return parts.join(" | ");
    }

    case "Enum": {
      if (hasGeneratedTypeNameCollision(ctx, type)) {
        return getGeneratedTypeName(ctx, type, "Enum");
      }
      const members = [...type.members.values()];
      return members.map((member) => enumMemberLiteralExpression(ctx.program, member)).join(" | ");
    }

    case "EnumMember":
      return enumMemberToTs(ctx, type);

    case "String":
    case "StringTemplate":
      return stringLiteralExpression(type);

    case "Number":
      return numericLiteralExpression(type);

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

function arrayTypeToTs(elementTs: string): string {
  const trimmed = elementTs.trim();
  return /[|&?]/.test(trimmed) ? `(${trimmed})[]` : `${trimmed}[]`;
}

export function templateParametersToTs(ctx: EmitterCtx, type: TemplatedType): string {
  if (!isTemplateDeclaration(type)) return "";
  const params = getTemplateParameters(type).map((param) =>
    templateParameterDeclarationToTs(ctx, param),
  );
  return params.length > 0 ? `<${params.join(", ")}>` : "";
}

export function isTypeSpecNamespaceModel(model: Model): boolean {
  // TypeSpec library helper models are not emitted as declarations, so inline
  // models from TypeSpec itself and nested library namespaces such as
  // TypeSpec.Http. Explicit cases such as HttpPart and File are handled first.
  let namespace = model.namespace;
  while (namespace) {
    if (namespace.name === "TypeSpec") return true;
    namespace = namespace.namespace;
  }
  return false;
}

export function isTemplatedScalarReference(scalar: Scalar): boolean {
  return shouldReferenceScalar(scalar);
}

export function isNamedUnionReference(union: Union): boolean {
  return Boolean(union.name);
}

export function isTemplatedUnionReference(union: Union): boolean {
  return Boolean(union.name && (isTemplateDeclaration(union) || isTemplateInstance(union)));
}

function modelToTs(ctx: EmitterCtx, model: Model): string {
  return templatedNamedTypeToTs(ctx, model, "Model");
}

function templatedNamedTypeToTs(
  ctx: EmitterCtx,
  type: Model | Scalar | Union,
  fallback: string,
): string {
  const name = getGeneratedTypeName(ctx, type, fallback);
  const args = type.templateMapper?.args.map((arg) => templateArgumentToTs(ctx, arg)) ?? [];
  return args.length > 0 ? `${name}<${args.join(", ")}>` : name;
}

function shouldReferenceScalar(scalar: Scalar): boolean {
  return Boolean(
    scalar.name &&
    scalar.namespace?.name !== "TypeSpec" &&
    (isTemplateDeclaration(scalar) || isTemplateInstance(scalar)),
  );
}

function getTemplateParameters(type: TemplatedType): readonly TemplateParameterDeclaration[] {
  const node = type.node;
  if (!node || !("templateParameters" in node)) return [];
  return node.templateParameters;
}

function templateParameterDeclarationToTs(
  ctx: EmitterCtx,
  param: TemplateParameterDeclaration,
): string {
  const name = tsIdentifier(param.id.sv, "T");
  const constraint = param.constraint ? templateParameterConstraintToTs(ctx, param.constraint) : "";
  const defaultType = param.default
    ? ` = ${typeToTs(ctx, ctx.program.checker.getTypeForNode(param.default))}`
    : "";
  return `${name}${constraint}${defaultType}`;
}

function templateParameterConstraintToTs(
  ctx: EmitterCtx,
  constraint: TemplateParameterDeclaration["constraint"],
): string {
  const constraintTarget =
    constraint?.kind === SyntaxKind.ValueOfExpression ? constraint.target : constraint;
  if (!constraintTarget) return "";
  // `valueof string` is a value constraint in TypeSpec. TypeScript has no
  // equivalent type-parameter value space, so the closest emitted constraint is
  // the underlying type.
  const tsType = typeToTs(ctx, ctx.program.checker.getTypeForNode(constraintTarget));
  return tsType === "unknown" ? "" : ` extends ${tsType}`;
}

function templateArgumentToTs(ctx: EmitterCtx, arg: unknown): string {
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
      return enumMemberToTs(ctx, value.value);
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

function enumMemberToTs(ctx: EmitterCtx, type: EnumMember): string {
  return enumMemberLiteralExpression(ctx.program, type);
}

function emitInlineModel(ctx: EmitterCtx, model: Model): string {
  const props = [...walkPropertiesInherited(model)].map((prop) => {
    return tsPropertyDeclaration(prop.name, typeToTs(ctx, prop.type), {
      optional: prop.optional,
    });
  });
  const indexer = modelAdditionalPropertiesToTs(ctx, model);
  if (indexer) props.push(indexer);
  return `{ ${props.join("; ")} }`;
}

/**
 * Emit the index signature for a model that combines declared fields with
 * explicit additional properties. TypeScript requires every named property to
 * be assignable to the index signature, so widen its value with those fields.
 */
export function modelAdditionalPropertiesToTs(ctx: EmitterCtx, model: Model): string | undefined {
  const additionalTypes = getAdditionalPropertiesValues(model);
  if (
    additionalTypes.length === 0 ||
    isPureRecordModel(model) ||
    isNeverAdditionalProperties(model)
  ) {
    return undefined;
  }

  const valueTypes = new Set<string>(
    additionalTypes.map((additionalType) => typeToTs(ctx, additionalType)),
  );
  for (const property of walkPropertiesInherited(model)) {
    valueTypes.add(typeToTs(ctx, property.type));
    if (property.optional) valueTypes.add("undefined");
  }
  return `[key: string]: ${[...valueTypes].join(" | ")}`;
}
