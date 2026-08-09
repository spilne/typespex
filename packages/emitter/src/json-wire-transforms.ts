import type { Model, ModelProperty, Type, Union } from "@typespec/compiler";
import { resolveEncodedName } from "@typespec/compiler";
import { getGeneratedTypeName, type EmitterCtx } from "./ctx.js";
import { getHttpPartType } from "./http-models.js";
import { getAdditionalPropertiesValue, isNeverAdditionalProperties } from "./model-indexer.js";
import {
  getPayloadCollection,
  payloadItemProjection,
  payloadModelProperties,
  payloadPropertyOptional,
  payloadTypeToTs,
  type PayloadProjection,
} from "./payload-context.js";
import { isTypeSpecNamespaceModel } from "./type-reference.js";
import { tsIdentifier } from "./typescript-names.js";

const JSON_MEDIA_TYPE = "application/json";

interface JsonSerializerEmission {
  readonly name: string;
  readonly type: Model;
  readonly projection?: PayloadProjection;
  declaration?: string;
  building?: boolean;
}

interface JsonWireState {
  readonly changes: Map<Type, Map<string, boolean>>;
  readonly serializers: Map<Model, Map<string, JsonSerializerEmission>>;
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
): boolean {
  const state = getState(ctx);
  let projections = state.changes.get(type);
  if (!projections) {
    projections = new Map();
    state.changes.set(type, projections);
  }

  const key = projection?.cacheKey ?? "raw";
  const cached = projections.get(key);
  if (cached !== undefined) return cached;

  const changed = computeJsonWireTransformChangesType(ctx, type, projection, new Map());
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
        );
      }
      const httpPartType = getHttpPartType(ctx.program, type);
      if (httpPartType) {
        return unsupportedJsonWireTransformReason(ctx, httpPartType, projection, nextSeen);
      }
      for (const property of payloadModelProperties(type, projection)) {
        const reason = unsupportedJsonWireTransformReason(ctx, property.type, projection, nextSeen);
        if (reason) return reason;
      }
      const additional = getAdditionalPropertiesValue(type);
      return additional && !isNeverAdditionalProperties(type)
        ? unsupportedJsonWireTransformReason(
            ctx,
            additional,
            payloadItemProjection(projection),
            nextSeen,
          )
        : undefined;
    }
    case "Union": {
      if (!jsonWireTransformChangesType(ctx, type, projection)) return undefined;
      const nonNull = nonNullUnionVariants(type);
      if (nonNull && nonNull.length === 1) {
        return unsupportedJsonWireTransformReason(ctx, nonNull[0]!, projection, nextSeen);
      }
      return `nested union ${JSON.stringify(type.name || "(anonymous)")} has multiple wire-transforming variants that cannot be distinguished from the handler value`;
    }
    case "Tuple": {
      const itemProjection = payloadItemProjection(projection);
      for (const value of type.values) {
        const reason = unsupportedJsonWireTransformReason(ctx, value, itemProjection, nextSeen);
        if (reason) return reason;
      }
      return undefined;
    }
    case "ModelProperty":
    case "UnionVariant":
      return unsupportedJsonWireTransformReason(ctx, type.type, projection, nextSeen);
    default:
      return undefined;
  }
}

/** Serializer expression for a transformed response body, or undefined when identity is enough. */
export function emitJsonWireSerializer(
  ctx: EmitterCtx,
  type: Type,
  projection?: PayloadProjection,
): string | undefined {
  return jsonWireTransformChangesType(ctx, type, projection)
    ? emitRequiredSerializer(ctx, type, projection)
    : undefined;
}

/** Hoisted lazy declarations accumulated while response encoders were rendered. */
export function getJsonWireSerializerDeclarations(ctx: EmitterCtx): readonly string[] {
  const state = getState(ctx);
  let pending = nextPendingSerializer(state);
  while (pending) {
    pending.building = true;
    const typeTs = payloadTypeToTs(ctx, pending.type, pending.projection);
    const body = emitObjectSerializer(ctx, pending.type, pending.projection);
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
  seen: Map<Type, Set<string>>,
): boolean {
  const projectionKey = projection?.cacheKey ?? "raw";
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
          seen,
        );
      }
      const httpPartType = getHttpPartType(ctx.program, type);
      if (httpPartType) {
        return computeJsonWireTransformChangesType(ctx, httpPartType, projection, seen);
      }

      for (const property of payloadModelProperties(type, projection)) {
        if (
          getJsonPropertyWireName(ctx, property) !== property.name ||
          computeJsonWireTransformChangesType(ctx, property.type, projection, seen)
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
          seen,
        ),
      );
    }
    case "Union":
      return [...type.variants.values()].some((variant) =>
        computeJsonWireTransformChangesType(ctx, variant.type, projection, seen),
      );
    case "Tuple":
      return type.values.some((value) =>
        computeJsonWireTransformChangesType(ctx, value, payloadItemProjection(projection), seen),
      );
    case "ModelProperty":
    case "UnionVariant":
      return computeJsonWireTransformChangesType(ctx, type.type, projection, seen);
    default:
      return false;
  }
}

function emitRequiredSerializer(
  ctx: EmitterCtx,
  type: Type,
  projection?: PayloadProjection,
): string {
  switch (type.kind) {
    case "Model": {
      const collection = getPayloadCollection(ctx, type);
      if (collection?.kind === "array") {
        return `JsonSerializers.array(${emitRequiredSerializer(ctx, collection.value, payloadItemProjection(projection))})`;
      }
      if (collection?.kind === "record") {
        return `JsonSerializers.record(${emitRequiredSerializer(ctx, collection.value, payloadItemProjection(projection))})`;
      }
      const httpPartType = getHttpPartType(ctx.program, type);
      if (httpPartType) return emitRequiredSerializer(ctx, httpPartType, projection);

      if (type.name && !isTypeSpecNamespaceModel(type)) {
        return getOrCreateSerializer(ctx, type, projection).name;
      }
      return emitObjectSerializer(ctx, type, projection);
    }
    case "Union": {
      const nonNull = nonNullUnionVariants(type);
      if (nonNull?.length === 1) {
        return `JsonSerializers.nullable(${emitRequiredSerializer(ctx, nonNull[0]!, projection)})`;
      }
      return identitySerializer(ctx, type, projection);
    }
    case "Tuple":
      return `JsonSerializers.tuple([${type.values
        .map((value) => emitRequiredSerializer(ctx, value, payloadItemProjection(projection)))
        .join(", ")}])`;
    case "ModelProperty":
    case "UnionVariant":
      return emitRequiredSerializer(ctx, type.type, projection);
    default:
      return identitySerializer(ctx, type, projection);
  }
}

function emitObjectSerializer(
  ctx: EmitterCtx,
  model: Model,
  projection?: PayloadProjection,
): string {
  const typeTs = payloadTypeToTs(ctx, model, projection);
  const properties = payloadModelProperties(model, projection).map((property) => {
    const fields = [
      `property: ${JSON.stringify(property.name)}`,
      `wireName: ${JSON.stringify(getJsonPropertyWireName(ctx, property))}`,
      `serializer: ${emitRequiredSerializer(ctx, property.type, projection)}`,
    ];
    if (payloadPropertyOptional(property, projection)) fields.push("optional: true");
    return `{ ${fields.join(", ")} }`;
  });

  const additional = getAdditionalPropertiesValue(model);
  const options =
    additional && !isNeverAdditionalProperties(model)
      ? `, { additionalProperties: ${emitRequiredSerializer(
          ctx,
          additional,
          payloadItemProjection(projection),
        )} }`
      : "";
  return `JsonSerializers.object<${typeTs}>([${properties.join(", ")}]${options})`;
}

function identitySerializer(ctx: EmitterCtx, type: Type, projection?: PayloadProjection): string {
  return `JsonSerializers.identity<${payloadTypeToTs(ctx, type, projection)}>()`;
}

function getOrCreateSerializer(
  ctx: EmitterCtx,
  model: Model,
  projection?: PayloadProjection,
): JsonSerializerEmission {
  const state = getState(ctx);
  let byProjection = state.serializers.get(model);
  if (!byProjection) {
    byProjection = new Map();
    state.serializers.set(model, byProjection);
  }

  const key = projection?.cacheKey ?? "raw";
  const existing = byProjection.get(key);
  if (existing) return existing;

  const typeName = getGeneratedTypeName(ctx, model, "Model");
  const projectionName = projection ? tsIdentifier(projection.cacheKey, "payload") : "raw";
  const baseName = `_jsonSerializer_${typeName}_${projectionName}`;
  let name = baseName;
  let suffix = 2;
  while (state.usedNames.has(name)) {
    name = `${baseName}_${suffix}`;
    suffix += 1;
  }
  state.usedNames.add(name);

  const serializer: JsonSerializerEmission = { name, type: model, projection };
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
