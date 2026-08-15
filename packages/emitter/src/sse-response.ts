import type {
  EnumMember,
  Model,
  ModelProperty,
  Type,
  Union,
  UnionVariant,
} from "@typespec/compiler";
import { getDiscriminator, isArrayModelType, walkPropertiesInherited } from "@typespec/compiler";
import { isJsonMediaType, isTextMediaType, normalizeMediaType } from "./body-media-kinds.js";
import type { EmitterCtx } from "./ctx.js";
import { getDateTimeMode } from "./datetime-mode.js";
import {
  emitJsonWireSerializer,
  unsupportedJsonWireTransformReason,
} from "./json-wire-transforms.js";
import { getAdditionalPropertiesValue, isNeverAdditionalProperties } from "./model-indexer.js";
import { enumMemberLiteralExpression, resolveNumericLiteral } from "./numeric-literals.js";
import {
  payloadModelProperties,
  payloadPropertyOptional,
  payloadTypeToTs,
  type PayloadProjection,
} from "./payload-context.js";
import { scalarToTs } from "./scalar-map.js";
import {
  getStringLiteralValue,
  isStringLikeLiteral,
  stringLiteralExpression,
} from "./string-template-literals.js";
import { tsLiteral, tsPropertyAccess } from "./typescript-names.js";
import { isTextResponseType } from "./wire-types.js";

// TypeSpec library state keys are global symbols. Reading the decorated program through those
// keys keeps the emitter compatible with the Events/SSE library versions installed by a service.
const EVENTS_STATE_KEY = Symbol.for("@typespec/events/events");
const EVENT_CONTENT_TYPE_STATE_KEY = Symbol.for("@typespec/events/contentType");
const EVENT_DATA_STATE_KEY = Symbol.for("@typespec/events/data");
const TERMINAL_EVENT_STATE_KEY = Symbol.for("@typespec/sse/terminalEvent");
const MODEL_VALUE_CONDITION =
  'typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array)';

export interface SseResponsePlan {
  readonly itemType: string;
  readonly transform: string;
}

export type SseResponsePlanResult =
  | { readonly supported: true; readonly plan: SseResponsePlan }
  | { readonly supported: false; readonly reason: string };

interface EventDefinition {
  readonly root: UnionVariant;
  readonly eventType?: string;
  readonly valueType: Type;
  readonly payloadType: Type;
  readonly payloadPath: readonly ModelProperty[];
  readonly payloadContentType?: string;
  readonly terminal: boolean;
}

interface DataPath {
  readonly properties: readonly ModelProperty[];
  readonly crossesCollection: boolean;
}

interface EventCondition {
  readonly category: string;
  readonly exactKey?: string;
  readonly exactCondition?: string;
  readonly broadCondition: string;
  readonly model?: Model;
}

/** Build the handler-value to SSE-frame lowering for one TypeSpec SSE stream. */
export function buildSseResponsePlan(
  ctx: EmitterCtx,
  streamType: Type,
  projection?: PayloadProjection,
): SseResponsePlanResult {
  if (streamType.kind !== "Union" || !ctx.program.stateSet(EVENTS_STATE_KEY).has(streamType)) {
    return unsupported("SSE response streams require a union decorated with @events");
  }

  const definitionsResult = collectEventDefinitions(ctx, streamType);
  if (!definitionsResult.supported) return definitionsResult;
  const definitions = definitionsResult.definitions;
  if (definitions.length === 0) {
    return unsupported("SSE response streams require at least one declared event variant");
  }

  const conditionsResult = buildEventConditions(ctx, streamType, definitions, projection);
  if (!conditionsResult.supported) return conditionsResult;

  const eventExpressions: string[] = [];
  for (const definition of definitions) {
    const expression = emitEventExpression(ctx, definition, projection);
    if (!expression.supported) return expression;
    eventExpressions.push(expression.expression);
  }

  const lines: string[] = ["(value) => {"];
  if (definitions.length === 1) {
    lines.push(`return ${eventExpressions[0]};`);
  } else {
    conditionsResult.conditions.forEach((condition, index) => {
      lines.push(`if (${condition}) return ${eventExpressions[index]};`);
    });
    lines.push(
      `throw new TypeError(${tsLiteral("SSE response value does not match any declared event variant.")});`,
    );
  }
  lines.push("}");

  return {
    supported: true,
    plan: {
      itemType: payloadTypeToTs(ctx, streamType, projection),
      transform: lines.join("\n"),
    },
  };
}

function collectEventDefinitions(
  ctx: EmitterCtx,
  union: Union,
):
  | { readonly supported: true; readonly definitions: readonly EventDefinition[] }
  | { readonly supported: false; readonly reason: string } {
  const contentTypes = ctx.program.stateMap(EVENT_CONTENT_TYPE_STATE_KEY);
  const dataProperties = ctx.program.stateSet(EVENT_DATA_STATE_KEY);
  const terminalEvents = ctx.program.stateSet(TERMINAL_EVENT_STATE_KEY);
  const definitions: EventDefinition[] = [];

  for (const variant of union.variants.values()) {
    const dataPaths = findDataPaths(variant.type, dataProperties);
    if (dataPaths.length > 1) {
      return unsupported(`${eventLabel(variant)} declares more than one @data payload`);
    }
    const [dataPath] = dataPaths;
    if (dataPath?.crossesCollection) {
      return unsupported(
        `${eventLabel(variant)} has a payload marked @data inside an array, record, tuple, or union`,
      );
    }
    if (dataPath?.properties.some((property) => property.optional)) {
      return unsupported(`${eventLabel(variant)} has an optional @data payload path`);
    }

    const payloadProperty = dataPath?.properties.at(-1);
    const payloadContentType = contentTypes.get(payloadProperty ?? variant);
    const eventType = typeof variant.name === "string" ? variant.name : undefined;
    if (eventType !== undefined && /[\0\r\n]/u.test(eventType)) {
      return unsupported(`${eventLabel(variant)} has an invalid SSE event name`);
    }

    definitions.push({
      root: variant,
      eventType,
      valueType: variant.type,
      payloadType: payloadProperty?.type ?? variant.type,
      payloadPath: dataPath?.properties ?? [],
      payloadContentType: typeof payloadContentType === "string" ? payloadContentType : undefined,
      terminal: terminalEvents.has(variant),
    });
  }

  return { supported: true, definitions };
}

function findDataPaths(type: Type, dataProperties: ReadonlySet<Type>): DataPath[] {
  const paths: DataPath[] = [];

  const visit = (
    current: Type,
    properties: readonly ModelProperty[],
    ancestors: ReadonlySet<Type>,
    crossesCollection: boolean,
  ): void => {
    if (ancestors.has(current)) return;
    const nextAncestors = new Set(ancestors).add(current);

    switch (current.kind) {
      case "Model": {
        const nextCrossesCollection = crossesCollection || current.indexer !== undefined;
        for (const property of walkPropertiesInherited(current)) {
          const nextProperties = [...properties, property];
          if (dataProperties.has(property)) {
            paths.push({ properties: nextProperties, crossesCollection: nextCrossesCollection });
          }
          visit(property.type, nextProperties, nextAncestors, nextCrossesCollection);
        }
        if (current.indexer) {
          visit(current.indexer.value, properties, nextAncestors, true);
        }
        return;
      }
      case "Union":
        for (const variant of current.variants.values()) {
          visit(variant.type, properties, nextAncestors, true);
        }
        return;
      case "Tuple":
        for (const value of current.values) {
          visit(value, properties, nextAncestors, true);
        }
        return;
      case "ModelProperty":
      case "UnionVariant":
        visit(current.type, properties, nextAncestors, crossesCollection);
        return;
      default:
        return;
    }
  };

  visit(type, [], new Set(), false);
  return paths;
}

function buildEventConditions(
  ctx: EmitterCtx,
  union: Union,
  definitions: readonly EventDefinition[],
  projection?: PayloadProjection,
):
  | { readonly supported: true; readonly conditions: readonly string[] }
  | { readonly supported: false; readonly reason: string } {
  if (definitions.length === 1) return { supported: true, conditions: ["true"] };

  const plans: EventCondition[] = [];
  for (const definition of definitions) {
    const plan = eventConditionFor(ctx, definition.valueType);
    if (!plan) {
      return unsupported(
        `${eventLabel(definition.root)} cannot be distinguished from other handler values`,
      );
    }
    plans.push(plan);
  }

  const conditions = new Array<string>(definitions.length);
  const indexesByCategory = new Map<string, number[]>();
  plans.forEach((plan, index) => {
    const indexes = indexesByCategory.get(plan.category) ?? [];
    indexes.push(index);
    indexesByCategory.set(plan.category, indexes);
  });

  const objectLikeScalarCategory = [...indexesByCategory.keys()].find(
    (category) => category === "date" || category.startsWith("Temporal."),
  );
  if (indexesByCategory.has("object") && objectLikeScalarCategory) {
    return unsupported("SSE model events overlap with object-valued scalar events at runtime");
  }

  for (const indexes of indexesByCategory.values()) {
    if (indexes.length === 1) {
      const index = indexes[0]!;
      conditions[index] = plans[index]!.exactCondition ?? plans[index]!.broadCondition;
      continue;
    }

    const categoryPlans = indexes.map((index) => plans[index]!);
    if (categoryPlans.every((plan) => plan.exactKey !== undefined)) {
      const keys = new Set(categoryPlans.map((plan) => plan.exactKey));
      if (keys.size !== categoryPlans.length) {
        return unsupported("SSE event variants contain duplicate literal handler values");
      }
      indexes.forEach((index) => {
        conditions[index] = plans[index]!.exactCondition!;
      });
      continue;
    }

    if (categoryPlans.every((plan) => plan.model !== undefined)) {
      const models = categoryPlans.map((plan) => plan.model!);
      const objectConditions = buildObjectConditions(ctx, union, models, projection);
      if (!objectConditions) {
        return unsupported(
          `SSE event variants ${indexes.map((index) => eventLabel(definitions[index]!.root)).join(", ")} have ambiguous object shapes`,
        );
      }
      indexes.forEach((index, objectIndex) => {
        conditions[index] = objectConditions[objectIndex]!;
      });
      continue;
    }

    return unsupported(
      `SSE event variants ${indexes.map((index) => eventLabel(definitions[index]!.root)).join(", ")} overlap at runtime`,
    );
  }

  return { supported: true, conditions };
}

function eventConditionFor(ctx: EmitterCtx, type: Type): EventCondition | undefined {
  if (isStringLikeLiteral(type)) {
    const value = getStringLiteralValue(type);
    if (value === undefined) return undefined;
    return {
      category: "string",
      exactKey: `string:${value}`,
      exactCondition: `value === ${stringLiteralExpression(type)}`,
      broadCondition: 'typeof value === "string"',
    };
  }
  if (type.kind === "Number") {
    const numeric = resolveNumericLiteral(type);
    if (!numeric.supported) return undefined;
    return {
      category: numeric.kind,
      exactKey: numeric.key,
      exactCondition: `value === ${numeric.expression}`,
      broadCondition: `typeof value === ${tsLiteral(numeric.kind)}`,
    };
  }
  if (type.kind === "Boolean") {
    return {
      category: "boolean",
      exactKey: `boolean:${String(type.value)}`,
      exactCondition: `value === ${String(type.value)}`,
      broadCondition: 'typeof value === "boolean"',
    };
  }
  if (type.kind === "EnumMember") return enumMemberCondition(ctx, type);
  if (type.kind === "Intrinsic" && type.name === "null") {
    return {
      category: "null",
      exactKey: "null",
      exactCondition: "value === null",
      broadCondition: "value === null",
    };
  }
  if (type.kind === "Model") {
    if (isArrayModelType(ctx.program, type)) {
      return { category: "array", broadCondition: "Array.isArray(value)" };
    }
    return {
      category: "object",
      broadCondition: MODEL_VALUE_CONDITION,
      model: type,
    };
  }
  if (type.kind === "Tuple") {
    return { category: "array", broadCondition: "Array.isArray(value)" };
  }
  if (type.kind !== "Scalar") return undefined;

  const tsType = scalarToTs(type, getDateTimeMode(ctx));
  switch (tsType) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
      return {
        category: tsType,
        broadCondition: `typeof value === ${tsLiteral(tsType)}`,
      };
    case "Uint8Array":
      return { category: "bytes", broadCondition: "value instanceof Uint8Array" };
    case "Date":
      return { category: "date", broadCondition: "value instanceof Date" };
    case "Temporal.PlainDate":
    case "Temporal.PlainTime":
    case "Temporal.Instant":
    case "Temporal.ZonedDateTime":
    case "Temporal.Duration":
      return { category: tsType, broadCondition: `value instanceof ${tsType}` };
    default:
      return undefined;
  }
}

function enumMemberCondition(ctx: EmitterCtx, member: EnumMember): EventCondition {
  const expression = enumMemberLiteralExpression(ctx.program, member);
  const category = typeof member.value === "number" ? "number" : "string";
  return {
    category,
    exactKey: `${category}:${expression}`,
    exactCondition: `value === ${expression}`,
    broadCondition: `typeof value === ${tsLiteral(category)}`,
  };
}

function buildObjectConditions(
  ctx: EmitterCtx,
  union: Union,
  models: readonly Model[],
  projection?: PayloadProjection,
): string[] | undefined {
  const explicitDiscriminator = getDiscriminator(ctx.program, union)?.propertyName;
  const discriminatorCandidates = [
    explicitDiscriminator,
    findCommonModelDiscriminator(ctx, models),
    ...collectLiteralPropertyNames(ctx, models, projection),
  ].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);

  for (const propertyName of discriminatorCandidates) {
    const values = models.map((model) =>
      literalPropertyCondition(ctx, model, propertyName, projection),
    );
    if (values.some((value) => value === undefined)) continue;
    const keys = new Set(values.map((value) => value!.key));
    if (keys.size !== models.length) continue;
    return values.map(
      (value) =>
        `${MODEL_VALUE_CONDITION} && ` +
        `Object.prototype.hasOwnProperty.call(value, ${tsLiteral(propertyName)}) && ` +
        `(value as unknown as Record<string, unknown>)[${tsLiteral(propertyName)}] === ${value!.expression}`,
    );
  }

  const properties = models.map((model) => payloadModelProperties(model, projection));
  const uniqueProperties: string[] = [];
  for (let index = 0; index < models.length; index += 1) {
    const property = properties[index]!.find(
      (candidate) =>
        !payloadPropertyOptional(candidate, projection) &&
        models.every(
          (other, otherIndex) =>
            otherIndex === index ||
            (!modelIsOpen(other) &&
              !properties[otherIndex]!.some(
                (otherProperty) => otherProperty.name === candidate.name,
              )),
        ),
    );
    if (!property) return undefined;
    uniqueProperties.push(property.name);
  }

  return uniqueProperties.map((property, index) => {
    const exclusions = uniqueProperties
      .filter((_, otherIndex) => otherIndex !== index)
      .map((other) => `!Object.prototype.hasOwnProperty.call(value, ${tsLiteral(other)})`);
    return [
      MODEL_VALUE_CONDITION,
      `Object.prototype.hasOwnProperty.call(value, ${tsLiteral(property)})`,
      ...exclusions,
    ].join(" && ");
  });
}

function findCommonModelDiscriminator(
  ctx: EmitterCtx,
  models: readonly Model[],
): string | undefined {
  const names = models.map((model) => {
    let current: Model | undefined = model;
    while (current) {
      const discriminator = getDiscriminator(ctx.program, current);
      if (discriminator) return discriminator.propertyName;
      current = current.baseModel;
    }
    return undefined;
  });
  const [first] = names;
  return first && names.every((name) => name === first) ? first : undefined;
}

function collectLiteralPropertyNames(
  ctx: EmitterCtx,
  models: readonly Model[],
  projection?: PayloadProjection,
): string[] {
  const names = new Set<string>();
  for (const model of models) {
    for (const property of payloadModelProperties(model, projection)) {
      if (!payloadPropertyOptional(property, projection) && literalValue(property.type, ctx)) {
        names.add(property.name);
      }
    }
  }
  return [...names];
}

function literalPropertyCondition(
  ctx: EmitterCtx,
  model: Model,
  propertyName: string,
  projection?: PayloadProjection,
): { readonly key: string; readonly expression: string } | undefined {
  const property = payloadModelProperties(model, projection).find(
    (candidate) => candidate.name === propertyName,
  );
  if (!property || payloadPropertyOptional(property, projection)) return undefined;
  return literalValue(property.type, ctx);
}

function literalValue(
  type: Type,
  ctx?: EmitterCtx,
): { readonly key: string; readonly expression: string } | undefined {
  if (isStringLikeLiteral(type)) {
    const value = getStringLiteralValue(type);
    return value === undefined
      ? undefined
      : { key: `string:${value}`, expression: stringLiteralExpression(type) };
  }
  if (type.kind === "Number") {
    const numeric = resolveNumericLiteral(type);
    return numeric.supported ? { key: numeric.key, expression: numeric.expression } : undefined;
  }
  if (type.kind === "Boolean") {
    return { key: `boolean:${String(type.value)}`, expression: String(type.value) };
  }
  if (type.kind === "EnumMember" && ctx) {
    const expression = enumMemberLiteralExpression(ctx.program, type);
    return { key: `enum:${expression}`, expression };
  }
  return undefined;
}

function modelIsOpen(model: Model): boolean {
  return getAdditionalPropertiesValue(model) !== undefined && !isNeverAdditionalProperties(model);
}

function emitEventExpression(
  ctx: EmitterCtx,
  definition: EventDefinition,
  projection?: PayloadProjection,
):
  | { readonly supported: true; readonly expression: string }
  | { readonly supported: false; readonly reason: string } {
  const contentType = definition.payloadContentType;
  const mediaType = contentType ? normalizeMediaType(contentType) : undefined;
  if (!mediaType) {
    return unsupported(`${eventLabel(definition.root)} requires a concrete payload content type`);
  }

  const payloadTarget = definition.payloadPath.at(-1);
  const transformReason = unsupportedJsonWireTransformReason(
    ctx,
    definition.payloadType,
    projection,
    new Set(),
    payloadTarget,
  );
  if (transformReason) {
    return unsupported(
      `${eventLabel(definition.root)} cannot serialize its payload: ${transformReason}`,
    );
  }

  let payload = `(value as ${payloadTypeToTs(ctx, definition.valueType, projection)})`;
  for (const property of definition.payloadPath) {
    payload = tsPropertyAccess(payload, property.name);
  }

  const payloadType = payloadTypeToTs(ctx, definition.payloadType, projection);
  const path = `$response[]${definition.payloadPath.map((property) => `.${property.name}`).join("")}`;
  const fields: string[] = [];
  if (definition.eventType !== undefined) fields.push(`event: ${tsLiteral(definition.eventType)}`);

  if (isJsonMediaType(mediaType)) {
    const serializer = emitJsonWireSerializer(
      ctx,
      definition.payloadType,
      projection,
      payloadTarget,
      "value",
    );
    const wireValue = serializer
      ? `${serializer}.serialize(${payload} as ${payloadType}, ${tsLiteral(path)})`
      : payload;
    fields.push(`data: stringifyJson(${wireValue})`);
  } else if (isTextMediaType(mediaType)) {
    if (!isTextResponseType(definition.payloadType)) {
      return unsupported(
        `${eventLabel(definition.root)} uses a text payload content type with a non-text value`,
      );
    }
    const serializer = emitJsonWireSerializer(
      ctx,
      definition.payloadType,
      projection,
      payloadTarget,
      "text",
    );
    const wireValue = serializer
      ? `${serializer}.serialize(${payload} as ${payloadType}, ${tsLiteral(path)})`
      : payload;
    fields.push(`data: String(${wireValue})`);
  } else {
    return unsupported(
      `${eventLabel(definition.root)} uses unsupported payload content type ${JSON.stringify(contentType)}`,
    );
  }

  if (definition.terminal) fields.push("terminal: true");
  return { supported: true, expression: `{ ${fields.join(", ")} }` };
}

function eventLabel(variant: UnionVariant): string {
  return typeof variant.name === "string"
    ? `SSE event ${JSON.stringify(variant.name)}`
    : "an unnamed SSE event";
}

function unsupported(reason: string): { readonly supported: false; readonly reason: string } {
  return { supported: false, reason };
}
