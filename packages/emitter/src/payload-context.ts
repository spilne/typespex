import type { Model, ModelProperty, Type, Union, VisibilityFilter } from "@typespec/compiler";
import {
  getLifecycleVisibilityEnum,
  getReturnTypeVisibilityFilter,
  isArrayModelType,
  isTemplateDeclaration,
  isType,
  walkPropertiesInherited,
} from "@typespec/compiler";
import {
  createMetadataInfo,
  HttpVisibilityProvider,
  resolveRequestVisibility,
  Visibility,
  type HttpOperation,
  type HttpOperationResponseContent,
  type HttpPayloadBody,
  type HttpProperty,
  type MetadataInfo,
} from "@typespec/http";
import { getGeneratedTypeName, type EmitterCtx } from "./ctx.js";
import { discriminatedUnionBodyToTs, resolveDiscriminatedUnion } from "./discriminated-unions.js";
import { getHttpPartType, isHttpFileModel } from "./http-models.js";
import {
  getAdditionalPropertiesValue,
  isNeverAdditionalProperties,
  isPureRecordModel,
} from "./model-indexer.js";
import { $lib } from "./lib.js";
import { getNamespaceFullName } from "./namespace-names.js";
import { isTypeSpecNamespaceModel, templateParametersToTs, typeToTs } from "./type-reference.js";
import { tsIdentifier, tsPropertyDeclaration } from "./typescript-names.js";

export type PayloadBodyContext = "explicit" | "root" | "implicit";

/**
 * Operation-specific HTTP payload context. The explicit-body flag is kept
 * separate from visibility because metadata decorators below `@body` are
 * ordinary payload fields, while visibility still applies there.
 */
export interface PayloadProjection {
  readonly metadata: MetadataInfo;
  readonly visibility: Visibility;
  readonly inExplicitBody: boolean;
  readonly cacheKey: string;
}

export interface PayloadCollection {
  readonly kind: "array" | "record";
  readonly value: Type;
}

interface PayloadTypeAlias {
  readonly name: string;
  readonly type: Model | Union;
  readonly projection: PayloadProjection;
  declaration?: string;
}

interface PayloadContextState {
  readonly metadata: MetadataInfo;
  readonly aliases: Map<Type, Map<string, PayloadTypeAlias>>;
  readonly projectionChanges: Map<Type, Map<string, boolean>>;
  readonly projectionFilters: Map<Type, Map<string, boolean>>;
  readonly usedAliasNames: Set<string>;
}

const payloadStates = new WeakMap<EmitterCtx, PayloadContextState>();

export function getPayloadBodyContext(
  body: HttpPayloadBody | undefined,
  properties: readonly HttpProperty[],
): PayloadBodyContext {
  if (!body || body.bodyKind !== "single") return "implicit";
  if (
    body.property &&
    properties.some(
      (property) => property.kind === "bodyRoot" && property.property === body.property,
    )
  ) {
    return "root";
  }
  return body.isExplicit ? "explicit" : "implicit";
}

export function getRequestBodyProjection(
  ctx: EmitterCtx,
  operation: HttpOperation,
): PayloadProjection | undefined {
  const body = operation.parameters.body;
  if (body?.bodyKind !== "single") return undefined;

  const visibility = resolveRequestVisibility(ctx.program, operation.operation, operation.verb);
  const bodyContext = getPayloadBodyContext(body, operation.parameters.properties);
  return createPayloadProjection(ctx, visibility, "request", bodyContext === "explicit");
}

export function getResponseBodyProjection(
  ctx: EmitterCtx,
  operation: HttpOperation,
  content: HttpOperationResponseContent,
): PayloadProjection | undefined {
  const body = content.body;
  if (body?.bodyKind !== "single") return undefined;

  const bodyContext = getPayloadBodyContext(body, content.properties);
  const visibility = resolveResponseVisibility(ctx, operation);
  return createPayloadProjection(ctx, visibility, "response", bodyContext === "explicit");
}

function resolveResponseVisibility(ctx: EmitterCtx, operation: HttpOperation): Visibility {
  const filter = getReturnTypeVisibilityFilter(
    ctx.program,
    operation.operation,
    HttpVisibilityProvider(operation.verb),
  );
  return visibilityFilterToHttpVisibility(ctx, operation, filter);
}

function visibilityFilterToHttpVisibility(
  ctx: EmitterCtx,
  operation: HttpOperation,
  filter: VisibilityFilter,
): Visibility {
  if (filter.all !== undefined || filter.none !== undefined) {
    $lib.reportDiagnostic(ctx.program, {
      code: "unsupported-visibility-filter",
      format: { operation: operation.operation.name },
      target: operation.operation,
    });
    return Visibility.None;
  }
  if (!filter.any) return Visibility.All;

  const lifecycle = getLifecycleVisibilityEnum(ctx.program);
  let visibility = Visibility.None;
  for (const modifier of filter.any) {
    if (modifier.enum !== lifecycle) continue;
    switch (modifier.name) {
      case "Read":
        visibility |= Visibility.Read;
        break;
      case "Create":
        visibility |= Visibility.Create;
        break;
      case "Update":
        visibility |= Visibility.Update;
        break;
      case "Delete":
        visibility |= Visibility.Delete;
        break;
      case "Query":
        visibility |= Visibility.Query;
        break;
    }
  }
  return visibility;
}

function createPayloadProjection(
  ctx: EmitterCtx,
  visibility: Visibility,
  disposition: "request" | "response",
  inExplicitBody: boolean,
): PayloadProjection {
  return {
    metadata: getPayloadContextState(ctx).metadata,
    visibility,
    inExplicitBody,
    cacheKey: `${disposition}:${visibility}:${inExplicitBody ? "explicit" : "payload"}`,
  };
}

export function payloadTypeToTs(
  ctx: EmitterCtx,
  type: Type,
  projection: PayloadProjection | undefined,
): string {
  if (!projection || !payloadProjectionChangesType(ctx, type, projection)) {
    return typeToTs(ctx, type);
  }
  return projectedTypeToTs(ctx, type, projection);
}

export function payloadModelProperties(
  model: Model,
  projection: PayloadProjection | undefined,
): readonly ModelProperty[] {
  const properties = [...walkPropertiesInherited(model)];
  if (!projection) return properties;
  return properties.filter((property) =>
    projection.metadata.isPayloadProperty(
      property,
      projection.visibility,
      projection.inExplicitBody,
    ),
  );
}

export function payloadPropertyOptional(
  property: ModelProperty,
  projection: PayloadProjection | undefined,
): boolean {
  return projection
    ? projection.metadata.isOptional(property, projection.visibility)
    : property.optional;
}

export function payloadItemProjection(
  projection: PayloadProjection | undefined,
): PayloadProjection | undefined {
  if (!projection || (projection.visibility & Visibility.Item) !== 0) return projection;
  const visibility = projection.visibility | Visibility.Item;
  return {
    ...projection,
    visibility,
    cacheKey: `${projection.cacheKey}:item`,
  };
}

/**
 * Returns the element/value type for both structural collections and
 * compiler-created `TypeSpec.Array<T>` / `TypeSpec.Record<T>` instances that
 * do not expose an indexer.
 */
export function getPayloadCollection(ctx: EmitterCtx, model: Model): PayloadCollection | undefined {
  const templateArgs = model.templateMapper?.args ?? [];
  const firstTemplateArg = templateArgs[0];
  const namespace = getNamespaceFullName(model.namespace);
  if (
    namespace === "TypeSpec" &&
    model.name === "Array" &&
    templateArgs.length === 1 &&
    isType(firstTemplateArg)
  ) {
    return {
      kind: "array",
      value: firstTemplateArg,
    };
  }

  if (isArrayModelType(ctx.program, model) && model.indexer) {
    return { kind: "array", value: model.indexer.value };
  }
  if (isPureRecordModel(model)) {
    return { kind: "record", value: getAdditionalPropertiesValue(model)! };
  }
  return undefined;
}

export function payloadProjectionChangesType(
  ctx: EmitterCtx,
  type: Type,
  projection: PayloadProjection | undefined,
): boolean {
  if (!projection) return false;

  const state = getPayloadContextState(ctx);
  let byProjection = state.projectionChanges.get(type);
  if (!byProjection) {
    byProjection = new Map();
    state.projectionChanges.set(type, byProjection);
  }

  const cached = byProjection.get(projection.cacheKey);
  if (cached !== undefined) return cached;

  const changed = computeProjectionChangesType(ctx, type, projection, new Map());
  byProjection.set(projection.cacheKey, changed);
  return changed;
}

/** Whether a projection removes at least one declared property from the JSON payload. */
export function payloadProjectionFiltersProperties(
  ctx: EmitterCtx,
  type: Type,
  projection: PayloadProjection,
): boolean {
  const state = getPayloadContextState(ctx);
  let byProjection = state.projectionFilters.get(type);
  if (!byProjection) {
    byProjection = new Map();
    state.projectionFilters.set(type, byProjection);
  }

  const cached = byProjection.get(projection.cacheKey);
  if (cached !== undefined) return cached;

  const filtered = computeProjectionFiltersProperties(ctx, type, projection, new Map());
  byProjection.set(projection.cacheKey, filtered);
  return filtered;
}

/**
 * Projection-specific aliases are needed when a transformed payload graph is
 * recursive. They are local to each generated server module and deterministic
 * for a service context.
 */
export function getPayloadTypeAliasDeclarations(ctx: EmitterCtx): readonly string[] {
  const aliases: PayloadTypeAlias[] = [];
  for (const byProjection of getPayloadContextState(ctx).aliases.values()) {
    aliases.push(...byProjection.values());
  }
  return aliases
    .filter(
      (alias): alias is PayloadTypeAlias & { declaration: string } =>
        alias.declaration !== undefined,
    )
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((alias) => alias.declaration);
}

function projectedTypeToTs(ctx: EmitterCtx, type: Type, projection: PayloadProjection): string {
  switch (type.kind) {
    case "Model": {
      const collection = getPayloadCollection(ctx, type);
      if (collection) {
        const valueTs = projectedTypeToTs(
          ctx,
          collection.value,
          payloadItemProjection(projection)!,
        );
        return collection.kind === "array" ? arrayTypeToTs(valueTs) : `Record<string, ${valueTs}>`;
      }

      const httpPartType = getHttpPartType(ctx.program, type);
      if (httpPartType) return projectedTypeToTs(ctx, httpPartType, projection);
      if (isHttpFileModel(ctx.program, type)) {
        return projectedModelBodyToTs(ctx, type, projection);
      }

      if (type.name && !isTypeSpecNamespaceModel(type)) {
        return getOrCreatePayloadAlias(ctx, type, projection);
      }
      return projectedModelBodyToTs(ctx, type, projection);
    }

    case "Union":
      if (type.name) return getOrCreatePayloadAlias(ctx, type, projection);
      return projectedUnionBodyToTs(ctx, type, projection);

    case "Tuple": {
      const itemProjection = payloadItemProjection(projection)!;
      return `[${type.values
        .map((value) => payloadTypeToTs(ctx, value, itemProjection))
        .join(", ")}]`;
    }

    case "ModelProperty":
    case "UnionVariant":
      return payloadTypeToTs(ctx, type.type, projection);

    default:
      return typeToTs(ctx, type);
  }
}

function projectedModelBodyToTs(
  ctx: EmitterCtx,
  model: Model,
  projection: PayloadProjection,
): string {
  const projectedProperties = payloadModelProperties(model, projection);
  const declarations: string[] = [];
  const propertyTypes = new Set<string>();
  for (const property of projectedProperties) {
    const propertyType = payloadTypeToTs(ctx, property.type, projection);
    const optional = payloadPropertyOptional(property, projection);
    declarations.push(
      tsPropertyDeclaration(property.name, propertyType, {
        optional,
      }),
    );
    propertyTypes.add(propertyType);
    if (optional) propertyTypes.add("undefined");
  }

  const additionalType = getAdditionalPropertiesValue(model);
  if (additionalType && !isNeverAdditionalProperties(model)) {
    const valueTypes = new Set<string>([
      payloadTypeToTs(ctx, additionalType, payloadItemProjection(projection)),
      ...propertyTypes,
    ]);
    declarations.push(`[key: string]: ${[...valueTypes].join(" | ")}`);
  }

  return declarations.length > 0 ? `{ ${declarations.join("; ")} }` : "Record<string, never>";
}

function projectedUnionBodyToTs(
  ctx: EmitterCtx,
  union: Union,
  projection: PayloadProjection,
): string {
  const discriminated = resolveDiscriminatedUnion(ctx.program, union);
  if (discriminated) {
    return discriminatedUnionBodyToTs(discriminated, ({ type }) =>
      payloadTypeToTs(ctx, type, projection),
    );
  }

  const variants = [...union.variants.values()].map((variant) =>
    payloadTypeToTs(ctx, variant.type, projection),
  );
  return variants.length > 0 ? variants.join(" | ") : "never";
}

function getOrCreatePayloadAlias(
  ctx: EmitterCtx,
  type: Model | Union,
  projection: PayloadProjection,
): string {
  const state = getPayloadContextState(ctx);
  let byProjection = state.aliases.get(type);
  if (!byProjection) {
    byProjection = new Map();
    state.aliases.set(type, byProjection);
  }

  const existing = byProjection.get(projection.cacheKey);
  if (existing) return payloadAliasReference(ctx, existing);

  const typeName = getGeneratedTypeName(ctx, type, type.kind === "Model" ? "Model" : "Union");
  const suffix = tsIdentifier(projection.cacheKey, "Payload");
  const baseName = `_TypespexPayload_${typeName}_${suffix}`;
  let name = baseName;
  let index = 2;
  while (state.usedAliasNames.has(name)) {
    name = `${baseName}_${index}`;
    index += 1;
  }
  state.usedAliasNames.add(name);

  const alias: PayloadTypeAlias = { name, type, projection };
  byProjection.set(projection.cacheKey, alias);

  const parameters = isTemplateDeclaration(type) ? templateParametersToTs(ctx, type) : "";
  const body =
    type.kind === "Model"
      ? projectedModelBodyToTs(ctx, type, projection)
      : projectedUnionBodyToTs(ctx, type, projection);
  alias.declaration = `type ${name}${parameters} = ${body};`;
  return payloadAliasReference(ctx, alias);
}

function payloadAliasReference(ctx: EmitterCtx, alias: PayloadTypeAlias): string {
  if (!isTemplateDeclaration(alias.type)) return alias.name;
  const args =
    alias.type.templateMapper?.args.filter(isType).map((argument) => typeToTs(ctx, argument)) ?? [];
  return args.length > 0 ? `${alias.name}<${args.join(", ")}>` : alias.name;
}

function computeProjectionChangesType(
  ctx: EmitterCtx,
  type: Type,
  projection: PayloadProjection,
  seen: Map<Type, Set<string>>,
): boolean {
  if (markProjectionSeen(seen, type, projection.cacheKey)) return false;

  switch (type.kind) {
    case "Model": {
      const collection = getPayloadCollection(ctx, type);
      if (collection) {
        const itemProjection = payloadItemProjection(projection)!;
        return computeProjectionChangesType(ctx, collection.value, itemProjection, seen);
      }

      const httpPartType = getHttpPartType(ctx.program, type);
      if (httpPartType) {
        return computeProjectionChangesType(ctx, httpPartType, projection, seen);
      }
      // A File is a DOM File only for resolved raw-file or multipart bodies.
      // In every single-body payload context it is the modeled JSON object
      // `{ contentType?, filename?, contents }`.
      if (isHttpFileModel(ctx.program, type)) return true;

      const properties = [...walkPropertiesInherited(type)];
      for (const property of properties) {
        if (
          !projection.metadata.isPayloadProperty(
            property,
            projection.visibility,
            projection.inExplicitBody,
          ) ||
          projection.metadata.isOptional(property, projection.visibility) !== property.optional
        ) {
          return true;
        }
      }
      if (
        properties.some((property) =>
          computeProjectionChangesType(ctx, property.type, projection, seen),
        )
      ) {
        return true;
      }

      const additionalType = getAdditionalPropertiesValue(type);
      return (
        additionalType !== undefined &&
        computeProjectionChangesType(ctx, additionalType, payloadItemProjection(projection)!, seen)
      );
    }

    case "Union":
      return [...type.variants.values()].some((variant) =>
        computeProjectionChangesType(ctx, variant.type, projection, seen),
      );

    case "Tuple": {
      const itemProjection = payloadItemProjection(projection)!;
      return type.values.some((value) =>
        computeProjectionChangesType(ctx, value, itemProjection, seen),
      );
    }

    case "ModelProperty":
    case "UnionVariant":
      return computeProjectionChangesType(ctx, type.type, projection, seen);

    default:
      return false;
  }
}

function computeProjectionFiltersProperties(
  ctx: EmitterCtx,
  type: Type,
  projection: PayloadProjection,
  seen: Map<Type, Set<string>>,
): boolean {
  if (markProjectionSeen(seen, type, projection.cacheKey)) return false;

  switch (type.kind) {
    case "Model": {
      const collection = getPayloadCollection(ctx, type);
      if (collection) {
        const itemProjection = payloadItemProjection(projection)!;
        return computeProjectionFiltersProperties(ctx, collection.value, itemProjection, seen);
      }

      const httpPartType = getHttpPartType(ctx.program, type);
      if (httpPartType) {
        return computeProjectionFiltersProperties(ctx, httpPartType, projection, seen);
      }
      if (isHttpFileModel(ctx.program, type)) return false;

      const properties = [...walkPropertiesInherited(type)];
      for (const property of properties) {
        if (
          !projection.metadata.isPayloadProperty(
            property,
            projection.visibility,
            projection.inExplicitBody,
          ) ||
          computeProjectionFiltersProperties(ctx, property.type, projection, seen)
        ) {
          return true;
        }
      }

      const additionalType = getAdditionalPropertiesValue(type);
      return Boolean(
        additionalType &&
        computeProjectionFiltersProperties(
          ctx,
          additionalType,
          payloadItemProjection(projection)!,
          seen,
        ),
      );
    }

    case "Union":
      return [...type.variants.values()].some((variant) =>
        computeProjectionFiltersProperties(ctx, variant.type, projection, seen),
      );

    case "Tuple": {
      const itemProjection = payloadItemProjection(projection)!;
      return type.values.some((value) =>
        computeProjectionFiltersProperties(ctx, value, itemProjection, seen),
      );
    }

    case "ModelProperty":
    case "UnionVariant":
      return computeProjectionFiltersProperties(ctx, type.type, projection, seen);

    default:
      return false;
  }
}

function markProjectionSeen(
  seen: Map<Type, Set<string>>,
  type: Type,
  projectionKey: string,
): boolean {
  const projections = seen.get(type);
  if (projections?.has(projectionKey)) return true;
  if (projections) {
    projections.add(projectionKey);
  } else {
    seen.set(type, new Set([projectionKey]));
  }
  return false;
}

function getPayloadContextState(ctx: EmitterCtx): PayloadContextState {
  let state = payloadStates.get(ctx);
  if (state) return state;

  state = {
    metadata: createMetadataInfo(ctx.program),
    aliases: new Map(),
    projectionChanges: new Map(),
    projectionFilters: new Map(),
    usedAliasNames: new Set(ctx.typeNames.values()),
  };
  payloadStates.set(ctx, state);
  return state;
}

function arrayTypeToTs(elementTs: string): string {
  const trimmed = elementTs.trim();
  return /[|&?]/.test(trimmed) ? `(${trimmed})[]` : `${trimmed}[]`;
}
