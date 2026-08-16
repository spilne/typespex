import type { Model, ModelProperty, Type, Union } from "@typespec/compiler";
import { resolveEncodedName } from "@typespec/compiler";
import { getGeneratedTypeName, type EmitterCtx } from "./ctx.js";
import { dateTimeScalarNeedsTransform, emitDateTimeSerializer } from "./datetime-mode.js";
import {
  discriminatedVariantToTs,
  discriminatedVariants,
  resolveDiscriminatedUnion,
} from "./discriminated-unions.js";
import { getHttpPartType } from "./http-models.js";
import { getAdditionalPropertiesValue, isNeverAdditionalProperties } from "./model-indexer.js";
import {
  getPayloadCollection,
  payloadItemProjection,
  payloadModelProperties,
  payloadProjectionFiltersProperties,
  payloadPropertyOptional,
  payloadTypeToTs,
  type PayloadProjection,
} from "./payload-context.js";
import {
  emitScalarEncodingSerializer,
  resolveScalarEncoding,
  type ScalarEncodingContext,
} from "./scalar-encoding.js";
import { isTypeSpecNamespaceModel } from "./type-reference.js";
import { numericLiteralExpression } from "./numeric-literals.js";
import { stringLiteralExpression } from "./string-template-literals.js";
import { tsIdentifier, tsLiteral, tsObjectKey } from "./typescript-names.js";

const JSON_MEDIA_TYPE = "application/json";

interface JsonSerializerEmission {
  readonly name: string;
  readonly type: Model | Union;
  readonly projection?: PayloadProjection;
  readonly encodingContext: ScalarEncodingContext;
  declaration?: string;
  building?: boolean;
}

interface JsonWireState {
  readonly changes: Map<Type, Map<string, boolean>>;
  readonly serializers: Map<Model | Union, Map<string, JsonSerializerEmission>>;
  readonly usedNames: Set<string>;
}

const states = new WeakMap<EmitterCtx, JsonWireState>();

/** Handler-facing property names remain stable; this resolves only the JSON wire spelling. */
export function getJsonPropertyWireName(ctx: EmitterCtx, property: ModelProperty): string {
  return resolveEncodedName(ctx.program, property, JSON_MEDIA_TYPE);
}

/** Whether serializing this value requires a generated JSON wire transform. */
export function jsonWireTransformChangesType(
  ctx: EmitterCtx,
  type: Type,
  projection?: PayloadProjection,
  target?: ModelProperty,
  encodingContext: ScalarEncodingContext = "value",
): boolean {
  if (target) {
    return computeJsonWireTransformChangesType(
      ctx,
      type,
      projection,
      target,
      encodingContext,
      new Map(),
    );
  }
  const state = getState(ctx);
  let projections = state.changes.get(type);
  if (!projections) {
    projections = new Map();
    state.changes.set(type, projections);
  }

  const key = `${encodingContext}:${projection?.cacheKey ?? "raw"}`;
  const cached = projections.get(key);
  if (cached !== undefined) return cached;

  const changed = computeJsonWireTransformChangesType(
    ctx,
    type,
    projection,
    undefined,
    encodingContext,
    new Map(),
  );
  projections.set(key, changed);
  return changed;
}

/**
 * Returns a reason when response serialization cannot safely choose a nested
 * transformed union variant. Nullable unions are unambiguous and supported.
 */
export function unsupportedJsonWireTransformReason(
  ctx: EmitterCtx,
  type: Type,
  projection?: PayloadProjection,
  seen: ReadonlySet<Type> = new Set(),
  target?: ModelProperty,
): string | undefined {
  if (seen.has(type)) return undefined;
  const nextSeen = new Set(seen).add(type);

  switch (type.kind) {
    case "Model": {
      const collection = getPayloadCollection(ctx, type);
      if (collection) {
        return unsupportedJsonWireTransformReason(
          ctx,
          collection.value,
          payloadItemProjection(projection),
          nextSeen,
          target,
        );
      }
      const httpPartType = getHttpPartType(ctx.program, type);
      if (httpPartType) {
        return unsupportedJsonWireTransformReason(ctx, httpPartType, projection, nextSeen, target);
      }
      for (const property of payloadModelProperties(type, projection)) {
        const reason = unsupportedJsonWireTransformReason(
          ctx,
          property.type,
          projection,
          nextSeen,
          property,
        );
        if (reason) return reason;
      }
      const additional = getAdditionalPropertiesValue(type);
      return additional && !isNeverAdditionalProperties(type)
        ? unsupportedJsonWireTransformReason(
            ctx,
            additional,
            payloadItemProjection(projection),
            nextSeen,
            undefined,
          )
        : undefined;
    }
    case "Union": {
      const discriminated = resolveDiscriminatedUnion(ctx.program, type);
      if (discriminated) {
        for (const variant of discriminatedVariants(discriminated)) {
          const reason = unsupportedJsonWireTransformReason(
            ctx,
            variant.type,
            projection,
            nextSeen,
            target,
          );
          if (reason) return reason;
        }
        return undefined;
      }
      if (!jsonWireTransformChangesType(ctx, type, projection, target)) return undefined;
      const nonNull = nonNullUnionVariants(type);
      if (nonNull && nonNull.length === 1) {
        return unsupportedJsonWireTransformReason(ctx, nonNull[0]!, projection, nextSeen, target);
      }
      const runtimeVariants = runtimeSerializableUnionVariants(ctx, type, projection);
      if (runtimeVariants) {
        for (const variant of runtimeVariants) {
          const reason = unsupportedJsonWireTransformReason(
            ctx,
            variant,
            projection,
            nextSeen,
            target,
          );
          if (reason) return reason;
        }
        return undefined;
      }
      return `nested union ${JSON.stringify(type.name || "(anonymous)")} has multiple wire-transforming variants that cannot be distinguished from the handler value`;
    }
    case "Tuple": {
      const itemProjection = payloadItemProjection(projection);
      for (const value of type.values) {
        const reason = unsupportedJsonWireTransformReason(
          ctx,
          value,
          itemProjection,
          nextSeen,
          target,
        );
        if (reason) return reason;
      }
      return undefined;
    }
    case "ModelProperty":
      return unsupportedJsonWireTransformReason(ctx, type.type, projection, nextSeen, type);
    case "UnionVariant":
      return unsupportedJsonWireTransformReason(ctx, type.type, projection, nextSeen, target);
    default:
      return undefined;
  }
}

/** Serializer expression for a transformed response body, or undefined when identity is enough. */
export function emitJsonWireSerializer(
  ctx: EmitterCtx,
  type: Type,
  projection?: PayloadProjection,
  target?: ModelProperty,
  encodingContext: ScalarEncodingContext = "value",
): string | undefined {
  return jsonWireTransformChangesType(ctx, type, projection, target, encodingContext)
    ? emitRequiredSerializer(ctx, type, projection, target, encodingContext)
    : undefined;
}

/** Serializer expression used by non-JSON textual codecs that still share scalar encodings. */
export function emitRequiredJsonWireSerializer(
  ctx: EmitterCtx,
  type: Type,
  projection?: PayloadProjection,
  target?: ModelProperty,
  encodingContext: ScalarEncodingContext = "value",
): string {
  return emitRequiredSerializer(ctx, type, projection, target, encodingContext);
}

/** Hoisted lazy declarations accumulated while response encoders were rendered. */
export function getJsonWireSerializerDeclarations(ctx: EmitterCtx): readonly string[] {
  const state = getState(ctx);
  let pending = nextPendingSerializer(state);
  while (pending) {
    pending.building = true;
    const typeTs = payloadTypeToTs(ctx, pending.type, pending.projection);
    const body =
      pending.type.kind === "Model"
        ? emitObjectSerializer(ctx, pending.type, pending.projection, pending.encodingContext)
        : emitUnionSerializerBody(ctx, pending.type, pending.projection, pending.encodingContext);
    pending.declaration = `const ${pending.name}: JsonSerializer<${typeTs}> = JsonSerializers.lazy<${typeTs}>(() => ${body});`;
    pending.building = false;
    pending = nextPendingSerializer(state);
  }

  return [...state.serializers.values()]
    .flatMap((byProjection) => [...byProjection.values()])
    .filter(
      (serializer): serializer is JsonSerializerEmission & { declaration: string } =>
        serializer.declaration !== undefined,
    )
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((serializer) => serializer.declaration);
}

function computeJsonWireTransformChangesType(
  ctx: EmitterCtx,
  type: Type,
  projection: PayloadProjection | undefined,
  target: ModelProperty | undefined,
  encodingContext: ScalarEncodingContext,
  seen: Map<Type, Set<string>>,
): boolean {
  if (projection && payloadProjectionFiltersProperties(ctx, type, projection)) return true;
  if (type.kind === "Scalar") {
    return (
      dateTimeScalarNeedsTransform(ctx, type) ||
      resolveScalarEncoding(ctx, type, target, encodingContext).status === "supported"
    );
  }
  const projectionKey = `${encodingContext}:${projection?.cacheKey ?? "raw"}`;
  const seenProjections = seen.get(type);
  if (seenProjections?.has(projectionKey)) return false;
  if (seenProjections) {
    seenProjections.add(projectionKey);
  } else {
    seen.set(type, new Set([projectionKey]));
  }

  switch (type.kind) {
    case "Model": {
      const collection = getPayloadCollection(ctx, type);
      if (collection) {
        return computeJsonWireTransformChangesType(
          ctx,
          collection.value,
          payloadItemProjection(projection),
          target,
          encodingContext,
          seen,
        );
      }
      const httpPartType = getHttpPartType(ctx.program, type);
      if (httpPartType) {
        return computeJsonWireTransformChangesType(
          ctx,
          httpPartType,
          projection,
          target,
          encodingContext,
          seen,
        );
      }

      for (const property of payloadModelProperties(type, projection)) {
        if (
          getJsonPropertyWireName(ctx, property) !== property.name ||
          computeJsonWireTransformChangesType(
            ctx,
            property.type,
            projection,
            property,
            encodingContext,
            seen,
          )
        ) {
          return true;
        }
      }
      const additional = getAdditionalPropertiesValue(type);
      return Boolean(
        additional &&
        !isNeverAdditionalProperties(type) &&
        computeJsonWireTransformChangesType(
          ctx,
          additional,
          payloadItemProjection(projection),
          undefined,
          encodingContext,
          seen,
        ),
      );
    }
    case "Union":
      // The emitted handler type includes the synthetic envelope/discriminator,
      // but a serializer is still required to validate dispatch and transform
      // the selected payload recursively.
      if (resolveDiscriminatedUnion(ctx.program, type)) return true;
      return [...type.variants.values()].some((variant) =>
        computeJsonWireTransformChangesType(
          ctx,
          variant.type,
          projection,
          target,
          encodingContext,
          seen,
        ),
      );
    case "Tuple":
      return type.values.some((value) =>
        computeJsonWireTransformChangesType(
          ctx,
          value,
          payloadItemProjection(projection),
          target,
          encodingContext,
          seen,
        ),
      );
    case "ModelProperty":
    case "UnionVariant":
      return computeJsonWireTransformChangesType(
        ctx,
        type.type,
        projection,
        type.kind === "ModelProperty" ? type : target,
        encodingContext,
        seen,
      );
    default:
      return false;
  }
}

function emitRequiredSerializer(
  ctx: EmitterCtx,
  type: Type,
  projection?: PayloadProjection,
  target?: ModelProperty,
  encodingContext: ScalarEncodingContext = "value",
): string {
  switch (type.kind) {
    case "Model": {
      const collection = getPayloadCollection(ctx, type);
      if (collection?.kind === "array") {
        return `JsonSerializers.array(${emitRequiredSerializer(ctx, collection.value, payloadItemProjection(projection), target, encodingContext)})`;
      }
      if (collection?.kind === "record") {
        return `JsonSerializers.record(${emitRequiredSerializer(ctx, collection.value, payloadItemProjection(projection), target, encodingContext)})`;
      }
      const httpPartType = getHttpPartType(ctx.program, type);
      if (httpPartType) {
        return emitRequiredSerializer(ctx, httpPartType, projection, target, encodingContext);
      }

      if (type.name && !isTypeSpecNamespaceModel(type)) {
        return getOrCreateSerializer(ctx, type, projection, encodingContext).name;
      }
      return emitObjectSerializer(ctx, type, projection, encodingContext);
    }
    case "Union": {
      const discriminated = resolveDiscriminatedUnion(ctx.program, type);
      if (discriminated) {
        return type.name
          ? getOrCreateSerializer(ctx, type, projection, encodingContext).name
          : emitDiscriminatedUnionSerializerBody(ctx, type, projection, encodingContext);
      }
      const nonNull = nonNullUnionVariants(type);
      if (nonNull?.length === 1) {
        return `JsonSerializers.nullable(${emitRequiredSerializer(ctx, nonNull[0]!, projection, target, encodingContext)})`;
      }
      if (runtimeSerializableUnionVariants(ctx, type, projection)) {
        return type.name
          ? getOrCreateSerializer(ctx, type, projection, encodingContext).name
          : emitRuntimeUnionSerializerBody(ctx, type, projection, encodingContext);
      }
      return identitySerializer(ctx, type, projection);
    }
    case "Tuple":
      return `JsonSerializers.tuple([${type.values
        .map((value) =>
          emitRequiredSerializer(
            ctx,
            value,
            payloadItemProjection(projection),
            target,
            encodingContext,
          ),
        )
        .join(", ")}])`;
    case "Scalar": {
      const encoding = resolveScalarEncoding(ctx, type, target, encodingContext);
      return encoding.status === "supported"
        ? emitScalarEncodingSerializer(ctx, encoding.plan)
        : dateTimeScalarNeedsTransform(ctx, type)
          ? emitDateTimeSerializer(ctx, type, "JsonSerializers.identity<string>()")
          : identitySerializer(ctx, type, projection);
    }
    case "String":
    case "StringTemplate":
      return `JsonSerializers.literal(${stringLiteralExpression(type)})`;
    case "Number":
      return `JsonSerializers.literal(${numericLiteralExpression(type)})`;
    case "Boolean":
      return `JsonSerializers.literal(${String(type.value)})`;
    case "Intrinsic":
      return type.name === "null"
        ? "JsonSerializers.literal(null)"
        : identitySerializer(ctx, type, projection);
    case "ModelProperty":
    case "UnionVariant":
      return emitRequiredSerializer(ctx, type.type, projection, target, encodingContext);
    default:
      return identitySerializer(ctx, type, projection);
  }
}

function emitObjectSerializer(
  ctx: EmitterCtx,
  model: Model,
  projection?: PayloadProjection,
  encodingContext: ScalarEncodingContext = "value",
  syntheticDiscriminator?: {
    readonly name: string;
    readonly typeTs: string;
  },
): string {
  const typeTs = syntheticDiscriminator?.typeTs ?? payloadTypeToTs(ctx, model, projection);
  const modelProperties = payloadModelProperties(model, projection);
  const properties: string[] = [];
  if (
    syntheticDiscriminator &&
    !modelProperties.some((property) => property.name === syntheticDiscriminator.name)
  ) {
    properties.push(emitSyntheticDiscriminatorSerializer(syntheticDiscriminator.name));
  }
  for (const property of modelProperties) {
    if (property.name === syntheticDiscriminator?.name) {
      properties.push(emitSyntheticDiscriminatorSerializer(syntheticDiscriminator.name));
      continue;
    }
    const fields = [
      `property: ${tsLiteral(property.name)}`,
      `wireName: ${tsLiteral(getJsonPropertyWireName(ctx, property))}`,
      `serializer: ${emitRequiredSerializer(ctx, property.type, projection, property, encodingContext)}`,
    ];
    if (payloadPropertyOptional(property, projection)) fields.push("optional: true");
    properties.push(`{ ${fields.join(", ")} }`);
  }

  const additional = getAdditionalPropertiesValue(model);
  const options =
    additional && !isNeverAdditionalProperties(model)
      ? `, { additionalProperties: ${emitRequiredSerializer(
          ctx,
          additional,
          payloadItemProjection(projection),
          undefined,
          encodingContext,
        )} }`
      : "";
  return `JsonSerializers.object<${typeTs}>([${properties.join(", ")}]${options})`;
}

function emitSyntheticDiscriminatorSerializer(name: string): string {
  return `{ property: ${tsLiteral(name)}, wireName: ${tsLiteral(name)}, serializer: JsonSerializers.identity() }`;
}

function emitUnionSerializerBody(
  ctx: EmitterCtx,
  union: Union,
  projection?: PayloadProjection,
  encodingContext: ScalarEncodingContext = "value",
): string {
  return resolveDiscriminatedUnion(ctx.program, union)
    ? emitDiscriminatedUnionSerializerBody(ctx, union, projection, encodingContext)
    : emitRuntimeUnionSerializerBody(ctx, union, projection, encodingContext);
}

function emitRuntimeUnionSerializerBody(
  ctx: EmitterCtx,
  union: Union,
  projection?: PayloadProjection,
  encodingContext: ScalarEncodingContext = "value",
): string {
  const variants = runtimeSerializableUnionVariants(ctx, union, projection);
  if (!variants) return identitySerializer(ctx, union, projection);

  const serializers = variants.map((variant) =>
    emitRuntimeUnionVariantSerializer(ctx, variant, projection, encodingContext),
  );
  return `JsonSerializers.union<${payloadTypeToTs(ctx, union, projection)}>([${serializers.join(
    ", ",
  )}])`;
}

function emitRuntimeUnionVariantSerializer(
  ctx: EmitterCtx,
  type: Type,
  projection: PayloadProjection | undefined,
  encodingContext: ScalarEncodingContext,
): string {
  const serializer = emitRequiredSerializer(ctx, type, projection, undefined, encodingContext);
  if (type.kind !== "Model") return serializer;
  if (getPayloadCollection(ctx, type) || getHttpPartType(ctx.program, type)) return serializer;

  const additional = getAdditionalPropertiesValue(type);
  if (additional && !isNeverAdditionalProperties(type)) return serializer;
  const properties = payloadModelProperties(type, projection).map((property) =>
    tsLiteral(property.name),
  );
  return `JsonSerializers.exactObject(${serializer}, [${properties.join(", ")}])`;
}

function emitDiscriminatedUnionSerializerBody(
  ctx: EmitterCtx,
  union: Union,
  projection?: PayloadProjection,
  encodingContext: ScalarEncodingContext = "value",
): string {
  const discriminated = resolveDiscriminatedUnion(ctx.program, union);
  if (!discriminated) return identitySerializer(ctx, union, projection);

  const entries: string[] = [];
  let defaultVariant: string | undefined;
  for (const variant of discriminatedVariants(discriminated)) {
    const payloadTs = payloadTypeToTs(ctx, variant.type, projection);
    const variantTs = discriminatedVariantToTs(discriminated, variant, payloadTs);
    let serializer: string;

    if (discriminated.options.envelope === "object") {
      serializer = `JsonSerializers.object<${variantTs}>([${emitSyntheticDiscriminatorSerializer(
        discriminated.options.discriminatorPropertyName,
      )}, { property: ${tsLiteral(
        discriminated.options.envelopePropertyName,
      )}, wireName: ${tsLiteral(
        discriminated.options.envelopePropertyName,
      )}, serializer: ${emitRequiredSerializer(
        ctx,
        variant.type,
        projection,
        undefined,
        encodingContext,
      )} }])`;
    } else if (variant.type.kind === "Model") {
      serializer = emitObjectSerializer(ctx, variant.type, projection, encodingContext, {
        name: discriminated.options.discriminatorPropertyName,
        typeTs: variantTs,
      });
    } else {
      // The preflight diagnostic suppresses output for this invalid inline
      // shape. Keep a safe placeholder for callers that render despite errors.
      serializer = `JsonSerializers.identity<${variantTs}>()`;
    }

    if (variant.tag === undefined) {
      defaultVariant = serializer;
    } else {
      entries.push(`${tsObjectKey(variant.tag)}: ${serializer}`);
    }
  }

  const options = defaultVariant ? `, { defaultVariant: ${defaultVariant} }` : "";
  return `JsonSerializers.discriminated<${payloadTypeToTs(ctx, union, projection)}>(${tsLiteral(
    discriminated.options.discriminatorPropertyName,
  )}, { ${entries.join(", ")} }${options})`;
}

function identitySerializer(ctx: EmitterCtx, type: Type, projection?: PayloadProjection): string {
  return `JsonSerializers.identity<${payloadTypeToTs(ctx, type, projection)}>()`;
}

function getOrCreateSerializer(
  ctx: EmitterCtx,
  type: Model | Union,
  projection?: PayloadProjection,
  encodingContext: ScalarEncodingContext = "value",
): JsonSerializerEmission {
  const state = getState(ctx);
  let byProjection = state.serializers.get(type);
  if (!byProjection) {
    byProjection = new Map();
    state.serializers.set(type, byProjection);
  }

  const key = `${encodingContext}:${projection?.cacheKey ?? "raw"}`;
  const existing = byProjection.get(key);
  if (existing) return existing;

  const typeName = getGeneratedTypeName(ctx, type, type.kind === "Model" ? "Model" : "Union");
  const projectionName = projection ? tsIdentifier(projection.cacheKey, "payload") : "raw";
  const contextName = encodingContext === "value" ? "" : `_${encodingContext}`;
  const baseName = `_jsonSerializer_${typeName}_${projectionName}${contextName}`;
  let name = baseName;
  let suffix = 2;
  while (state.usedNames.has(name)) {
    name = `${baseName}_${suffix}`;
    suffix += 1;
  }
  state.usedNames.add(name);

  const serializer: JsonSerializerEmission = {
    name,
    type,
    projection,
    encodingContext,
  };
  byProjection.set(key, serializer);
  return serializer;
}

function nextPendingSerializer(state: JsonWireState): JsonSerializerEmission | undefined {
  for (const byProjection of state.serializers.values()) {
    for (const serializer of byProjection.values()) {
      if (!serializer.declaration && !serializer.building) return serializer;
    }
  }
  return undefined;
}

/**
 * Returns variants whose handler-facing shapes can be tried independently at
 * runtime. Duplicate shapes remain a generation-time error because the
 * handler value carries no evidence that can select between them.
 */
function runtimeSerializableUnionVariants(
  ctx: EmitterCtx,
  union: Union,
  projection?: PayloadProjection,
): readonly Type[] | undefined {
  const variants = [...union.variants.values()].map((variant) => variant.type);
  const shapeKeys = variants.map((variant) =>
    runtimeUnionVariantShapeKey(ctx, variant, projection),
  );
  if (shapeKeys.some((key) => key === undefined)) return undefined;
  return new Set(shapeKeys).size === shapeKeys.length ? variants : undefined;
}

function runtimeUnionVariantShapeKey(
  ctx: EmitterCtx,
  type: Type,
  projection?: PayloadProjection,
): string | undefined {
  if (type.kind === "Model") {
    const collection = getPayloadCollection(ctx, type);
    if (collection?.kind === "array") return "array";
    if (collection?.kind === "record") return "record";
    const httpPartType = getHttpPartType(ctx.program, type);
    if (httpPartType) return runtimeUnionVariantShapeKey(ctx, httpPartType, projection);

    const additional = getAdditionalPropertiesValue(type);
    const openness = additional && !isNeverAdditionalProperties(type) ? "open" : "closed";
    const properties = payloadModelProperties(type, projection)
      .map((property) => {
        const optional = payloadPropertyOptional(property, projection) ? "optional" : "required";
        return `${JSON.stringify(property.name)}:${optional}:${literalShapeKey(property.type)}`;
      })
      .sort();
    return `object:${openness}:{${properties.join(",")}}`;
  }
  if (type.kind === "Tuple") return `tuple:${type.values.length}`;
  if (type.kind === "Intrinsic" && type.name === "null") return "literal:null";
  return undefined;
}

function literalShapeKey(type: Type): string {
  switch (type.kind) {
    case "String":
    case "StringTemplate":
      return `literal:${stringLiteralExpression(type)}`;
    case "Number":
      return `literal:${numericLiteralExpression(type)}`;
    case "Boolean":
      return `literal:${String(type.value)}`;
    case "Intrinsic":
      return type.name === "null" ? "literal:null" : "value";
    default:
      return "value";
  }
}

/** Returns non-null variants when the union is nullable, otherwise undefined. */
function nonNullUnionVariants(union: Union): Type[] | undefined {
  const variants = [...union.variants.values()].map((variant) => variant.type);
  const nonNull = variants.filter(
    (variant) => variant.kind !== "Intrinsic" || variant.name !== "null",
  );
  return nonNull.length < variants.length ? nonNull : undefined;
}

function getState(ctx: EmitterCtx): JsonWireState {
  let state = states.get(ctx);
  if (state) return state;
  state = {
    changes: new Map(),
    serializers: new Map(),
    usedNames: new Set(ctx.typeNames.values()),
  };
  states.set(ctx, state);
  return state;
}
