import type { ModelProperty, Type } from "@typespec/compiler";
import { isArrayModelType, walkPropertiesInherited } from "@typespec/compiler";
import type { HttpOperationParameter } from "@typespec/http";
import type { EmitterCtx } from "./ctx.js";
import { getAdditionalPropertiesValue, isNeverAdditionalProperties } from "./model-indexer.js";
import { getPayloadCollection } from "./payload-context.js";

/** Values that can be represented by one HTTP parameter component. */
export function isWireScalarType(type: Type): boolean {
  switch (type.kind) {
    case "Scalar":
    case "Enum":
    case "String":
    case "StringTemplate":
    case "Number":
    case "Boolean":
    case "Intrinsic":
      return true;
    case "Union":
      return [...type.variants.values()].every((variant) => isWireScalarType(variant.type));
    case "UnionVariant":
    case "ModelProperty":
      return isWireScalarType(type.type);
    case "Model":
      return false;
    default:
      return false;
  }
}

/** Whether a query parameter is an exploded open record with scalar values. */
export function isExplodedQueryRecord(ctx: EmitterCtx, parameter: HttpOperationParameter): boolean {
  if (parameter.type !== "query" || !parameter.explode || parameter.param.type.kind !== "Model") {
    return false;
  }
  const collection = getPayloadCollection(ctx, parameter.param.type);
  return collection?.kind === "record" && isWireScalarType(collection.value);
}

/** Whether a query parameter requests exploded serialization for a finite object model. */
export function isExplodedQueryModelCandidate(
  ctx: EmitterCtx,
  parameter: HttpOperationParameter,
): boolean {
  if (parameter.type !== "query" || !parameter.explode || parameter.param.type.kind !== "Model") {
    return false;
  }
  return (
    !isArrayModelType(ctx.program, parameter.param.type) &&
    getPayloadCollection(ctx, parameter.param.type) === undefined
  );
}

/** Explains why a finite exploded query model cannot be decoded, if applicable. */
export function unsupportedExplodedQueryModelReason(
  ctx: EmitterCtx,
  parameter: HttpOperationParameter,
): string | undefined {
  if (!isExplodedQueryModelCandidate(ctx, parameter) || parameter.param.type.kind !== "Model") {
    return undefined;
  }

  const model = parameter.param.type;
  const additionalProperties = getAdditionalPropertiesValue(model);
  if (additionalProperties !== undefined && !isNeverAdditionalProperties(model)) {
    return "exploded query models cannot declare open additional properties";
  }

  const unsupportedProperty = [...walkPropertiesInherited(model)].find(
    (property) => !isWireScalarType(property.type),
  );
  return unsupportedProperty
    ? `exploded query model property ${JSON.stringify(unsupportedProperty.name)} must have a scalar, literal, enum, or scalar-union wire shape`
    : undefined;
}

/** Declared properties owned by a supported finite exploded query model. */
export function getExplodedQueryModelProperties(
  ctx: EmitterCtx,
  parameter: HttpOperationParameter,
): readonly ModelProperty[] | undefined {
  if (
    !isExplodedQueryModelCandidate(ctx, parameter) ||
    unsupportedExplodedQueryModelReason(ctx, parameter) !== undefined ||
    parameter.param.type.kind !== "Model"
  ) {
    return undefined;
  }
  return [...walkPropertiesInherited(parameter.param.type)];
}
