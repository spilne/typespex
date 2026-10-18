/**
 * Decides when a JSON response wire value needs none of the runtime's lossless
 * JSON extensions, so the generated encoder can use the platform serializer.
 */
import type { ModelProperty, Type } from "@typespec/compiler";
import type { EmitterCtx } from "./ctx.js";
import { dateTimeScalarNeedsTransform } from "./datetime-mode.js";
import { getHttpPartType } from "./http-models.js";
import { getAdditionalPropertiesValue, isNeverAdditionalProperties } from "./model-indexer.js";
import { resolveNumericLiteral } from "./numeric-literals.js";
import {
  getPayloadCollection,
  payloadItemProjection,
  payloadModelProperties,
  type PayloadProjection,
} from "./payload-context.js";
import { resolveScalarEncoding, type ScalarEncodingContext } from "./scalar-encoding.js";
import { scalarToTs } from "./scalar-map.js";

/**
 * True when every wire value of `type` is a JSON string, finite number,
 * boolean, null, array, or plain object of those after the generated
 * serializer has run. Such values carry no bigint, bytes, or unknown data, so
 * `JSON.stringify` and the runtime's direct writer agree on every byte.
 *
 * Records are excluded: integer-like keys are slow in native JSON on Bun, and
 * the runtime's direct writer keeps handling them.
 */
export function isNativeJsonWireType(
  ctx: EmitterCtx,
  type: Type,
  projection?: PayloadProjection,
  target?: ModelProperty,
  encodingContext: ScalarEncodingContext = "value",
): boolean {
  return nativeJsonWireType(ctx, type, projection, target, encodingContext, new Set());
}

function nativeJsonWireType(
  ctx: EmitterCtx,
  type: Type,
  projection: PayloadProjection | undefined,
  target: ModelProperty | undefined,
  encodingContext: ScalarEncodingContext,
  seen: Set<Type>,
): boolean {
  switch (type.kind) {
    case "Model": {
      const collection = getPayloadCollection(ctx, type);
      if (collection) {
        return (
          collection.kind === "array" &&
          nativeJsonWireType(
            ctx,
            collection.value,
            payloadItemProjection(projection),
            target,
            encodingContext,
            seen,
          )
        );
      }
      const httpPartType = getHttpPartType(ctx.program, type);
      if (httpPartType) {
        return nativeJsonWireType(ctx, httpPartType, projection, target, encodingContext, seen);
      }
      const additional = getAdditionalPropertiesValue(type);
      if (additional && !isNeverAdditionalProperties(type)) return false;
      // A recursive reference is safe when every other branch is.
      if (seen.has(type)) return true;
      seen.add(type);
      return payloadModelProperties(type, projection).every((property) =>
        nativeJsonWireType(ctx, property.type, projection, property, encodingContext, seen),
      );
    }
    case "Union":
      if (seen.has(type)) return true;
      seen.add(type);
      return [...type.variants.values()].every((variant) =>
        nativeJsonWireType(ctx, variant.type, projection, target, encodingContext, seen),
      );
    case "Tuple":
      return type.values.every((value) =>
        nativeJsonWireType(
          ctx,
          value,
          payloadItemProjection(projection),
          target,
          encodingContext,
          seen,
        ),
      );
    case "Scalar": {
      const encoding = resolveScalarEncoding(ctx, type, target, encodingContext);
      if (encoding.status === "supported")
        return isJsonPrimitiveTs(scalarToTs(encoding.plan.wireType));
      if (encoding.status === "unsupported") return false;
      // Date and Temporal handler values are serialized to strings.
      if (dateTimeScalarNeedsTransform(ctx, type)) return true;
      return isJsonPrimitiveTs(scalarToTs(type));
    }
    case "Enum":
    case "EnumMember":
    case "String":
    case "StringTemplate":
    case "Boolean":
      return true;
    case "Number": {
      const literal = resolveNumericLiteral(type);
      return literal.supported && literal.kind === "number";
    }
    case "Intrinsic":
      return type.name === "null";
    case "ModelProperty":
      return nativeJsonWireType(ctx, type.type, projection, type, encodingContext, seen);
    case "UnionVariant":
      return nativeJsonWireType(ctx, type.type, projection, target, encodingContext, seen);
    default:
      return false;
  }
}

function isJsonPrimitiveTs(tsType: string): boolean {
  return tsType === "string" || tsType === "number" || tsType === "boolean";
}
