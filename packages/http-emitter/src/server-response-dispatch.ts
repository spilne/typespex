/**
 * Builds deterministic runtime predicates for dispatching response unions.
 */
import type { Model, ModelProperty, Type } from "@typespec/compiler";
import {
  getDiscriminator,
  isArrayModelType,
  isRecordModelType,
  walkPropertiesInherited,
} from "@typespec/compiler";
import type { HttpOperation } from "@typespec/http";
import { isHeader } from "@typespec/http";
import type { EmitterCtx } from "./ctx.js";
import { getDateTimeMode } from "./datetime-mode.js";
import { getAdditionalPropertiesValue, isNeverAdditionalProperties } from "./model-indexer.js";
import { numericLiteralExpression, resolveNumericLiteral } from "./numeric-literals.js";
import { scalarToTs } from "./scalar-map.js";
import {
  getStringLiteralValue,
  isStringLikeLiteral,
  stringLiteralExpression,
} from "./string-template-literals.js";
import {
  type DynamicResponseStatusPlan,
  type ResponseStatusContract,
  type ResponseVariant,
} from "./server-response-plan.js";
import { tsLiteral } from "./typescript-names.js";

export interface ResponseBranch {
  readonly response: ResponseVariant;
  readonly condition: string;
}

export function buildResponseBranches(
  ctx: EmitterCtx,
  op: HttpOperation,
  responses: readonly ResponseVariant[],
): ResponseBranch[] {
  const branches = collectBranches(ctx, op, responses);
  // Branches that share a `when` predicate are not really distinguishable —
  // the first match wins and later variants are dead code. Reject so the
  // caller emits the undifferentiable diagnostic + unsupported placeholder.
  const seen = new Set<string>();
  for (const branch of branches) {
    if (seen.has(branch.condition)) return [];
    seen.add(branch.condition);
  }
  return branches;
}

function collectBranches(
  ctx: EmitterCtx,
  op: HttpOperation,
  responses: readonly ResponseVariant[],
): ResponseBranch[] {
  const branches: ResponseBranch[] = [];
  const pending = new Set(responses);
  let closedEmptyObjectResponse: ResponseVariant | undefined;

  const voidResponses = responses.filter((response) => response.isVoid);
  if (voidResponses.length > 1) return [];
  if (voidResponses.length === 1) {
    const [response] = voidResponses;
    branches.push({ response, condition: "result === undefined" });
    pending.delete(response);
  }

  const statusBranches = resolveDynamicStatusBranches(ctx, op, [...pending]);
  if (statusBranches === "ambiguous") return [];
  if (statusBranches) {
    branches.push(...statusBranches);
    for (const branch of statusBranches) pending.delete(branch.response);
    if (pending.size === 0) return branches;
  }

  // Envelope body-shape discriminator: when the remaining variants are
  // envelope shapes (a single `body` property) and their body runtime types
  // are distinguishable (array vs string vs number vs bytes vs object),
  // dispatch on `result.body`'s shape. Necessary for same-status,
  // different-content-type operations whose bodies are scalars/arrays —
  // the object-only path below wouldn't accept them.
  const bodyShapeBranches = resolveEnvelopeBodyShapeBranches(ctx, [...pending]);
  if (bodyShapeBranches) {
    branches.push(...bodyShapeBranches);
    for (const branch of bodyShapeBranches) pending.delete(branch.response);
    if (pending.size === 0) return branches;
  }

  const closedEmptyObjectResponses = [...pending].filter(isClosedEmptyObjectResult);
  if (closedEmptyObjectResponses.length > 1) return [];
  if (closedEmptyObjectResponses.length === 1) {
    [closedEmptyObjectResponse] = closedEmptyObjectResponses;
    pending.delete(closedEmptyObjectResponse);
    if (pending.size === 0) {
      return appendClosedEmptyObjectBranch(branches, closedEmptyObjectResponse);
    }
  }

  for (const response of [...pending]) {
    const condition = emitDirectTypeCondition(ctx, response);
    if (!condition) continue;
    branches.push({ response, condition });
    pending.delete(response);
  }

  if (pending.size === 0) {
    return appendClosedEmptyObjectBranch(branches, closedEmptyObjectResponse);
  }

  const objectResponses = [...pending].filter(
    (response) => response.model && !isArrayModelType(ctx.program, response.model),
  );
  if (objectResponses.length !== pending.size) return [];

  if (objectResponses.length === 1) {
    const [single] = objectResponses;
    if (closedEmptyObjectResponse) {
      const requiredProperty = getResponseProperties(single).find(
        (property) => !property.optional && !isResponseDispatchMetadata(ctx, single, property.name),
      );
      if (!requiredProperty) return [];
      branches.push({
        response: single,
        condition: emitExclusivePropertyCondition(single, requiredProperty.name, []),
      });
      return appendClosedEmptyObjectBranch(branches, closedEmptyObjectResponse);
    }
    branches.push({
      response: single,
      condition: emitObjectShapeCondition(single),
    });
    return branches;
  }

  const explicitDiscriminator = resolveExplicitDiscriminatorBranches(ctx, op, objectResponses);
  if (explicitDiscriminator) {
    branches.push(...explicitDiscriminator);
    return appendClosedEmptyObjectBranch(branches, closedEmptyObjectResponse);
  }

  const literalDiscriminator = resolveImplicitLiteralBranches(ctx, objectResponses);
  if (literalDiscriminator) {
    branches.push(...literalDiscriminator);
    return appendClosedEmptyObjectBranch(branches, closedEmptyObjectResponse);
  }

  const propertyMatcher = resolvePropertyBranches(ctx, objectResponses);
  if (propertyMatcher) {
    branches.push(...propertyMatcher);
    return appendClosedEmptyObjectBranch(branches, closedEmptyObjectResponse);
  }

  return [];
}

function resolveDynamicStatusBranches(
  ctx: EmitterCtx,
  op: HttpOperation,
  responses: readonly ResponseVariant[],
): ResponseBranch[] | "ambiguous" | undefined {
  if (responses.length < 2) return undefined;

  const dynamicResponses = responses.filter((response) => response.dynamicStatus);
  if (dynamicResponses.length === 0) return undefined;
  const fixedResponses = responses.filter((response) => !response.dynamicStatus);

  for (let left = 0; left < dynamicResponses.length; left += 1) {
    for (let right = left + 1; right < dynamicResponses.length; right += 1) {
      const leftStatus = dynamicResponses[left].dynamicStatus!;
      const rightStatus = dynamicResponses[right].dynamicStatus!;
      if (
        leftStatus.property.name === rightStatus.property.name &&
        statusContractsOverlap(leftStatus.allowed, rightStatus.allowed)
      ) {
        return undefined;
      }
    }
  }

  const statusProperties = [
    ...new Set(dynamicResponses.map((response) => response.dynamicStatus!.property.name)),
  ];

  // A same-named body/header property on another variant would make presence
  // of the dynamic status property ambiguous. Fall back to shape dispatch.
  for (const response of responses) {
    const ownStatusProperty = response.dynamicStatus?.property.name;
    for (const property of statusProperties) {
      if (
        property !== ownStatusProperty &&
        responseExposesHandlerProperty(ctx, response, property)
      ) {
        // An indexed direct body can legally materialize every discriminator
        // property and overlap all later shape predicates. Treat that case as
        // terminal ambiguity instead of silently falling through.
        return responseHasOpenHandlerProperties(response) ? "ambiguous" : undefined;
      }
    }
  }

  const branches = dynamicResponses.map((response) => ({
    response,
    condition: emitDynamicStatusCondition(
      response.dynamicStatus!,
      statusProperties.filter((property) => property !== response.dynamicStatus!.property.name),
    ),
  }));
  const [fixedResponse] = fixedResponses;
  if (fixedResponses.length === 1 && fixedResponse) {
    branches.push({
      response: fixedResponse,
      condition: emitAbsentStatusPropertiesCondition(statusProperties),
    });
  } else if (fixedResponses.length > 1) {
    const fixedBranches = buildResponseBranches(ctx, op, fixedResponses);
    if (fixedBranches.length !== fixedResponses.length) return undefined;

    const absentStatus = emitAbsentStatusPropertiesCondition(statusProperties);
    branches.push(
      ...fixedBranches.map((branch) => ({
        response: branch.response,
        condition: `(${absentStatus}) && (${branch.condition})`,
      })),
    );
  }
  return branches;
}

function statusContractsOverlap(
  left: readonly ResponseStatusContract[],
  right: readonly ResponseStatusContract[],
): boolean {
  return left.some((leftStatus) =>
    right.some((rightStatus) => {
      const leftRange =
        typeof leftStatus === "number" ? { start: leftStatus, end: leftStatus } : leftStatus;
      const rightRange =
        typeof rightStatus === "number" ? { start: rightStatus, end: rightStatus } : rightStatus;
      return leftRange.start <= rightRange.end && rightRange.start <= leftRange.end;
    }),
  );
}

function emitDynamicStatusCondition(
  status: DynamicResponseStatusPlan,
  excludedProperties: readonly string[] = [],
): string {
  const property = tsLiteral(status.property.name);
  const value = `(result as Record<string, unknown>)[${property}]`;
  const allowed = status.allowed
    .map((entry) =>
      typeof entry === "number"
        ? `${value} === ${entry}`
        : `(${value} as number) >= ${entry.start} && (${value} as number) <= ${entry.end}`,
    )
    .map((condition) => `(${condition})`)
    .join(" || ");
  const excluded = excludedProperties
    .map((name) => `!Object.prototype.hasOwnProperty.call(result, ${tsLiteral(name)})`)
    .join(" && ");
  return [
    `typeof result === "object"`,
    `result !== null`,
    `Object.prototype.hasOwnProperty.call(result, ${property})`,
    `typeof ${value} === "number"`,
    `(${allowed})`,
    excluded,
  ]
    .filter(Boolean)
    .join(" && ");
}

function emitAbsentStatusPropertiesCondition(properties: readonly string[]): string {
  const absent = properties
    .map((property) => `!Object.prototype.hasOwnProperty.call(result, ${tsLiteral(property)})`)
    .join(" && ");
  return `typeof result !== "object" || result === null || (${absent})`;
}

function responseHasOpenHandlerProperties(response: ResponseVariant): boolean {
  return (
    response.bodyProperty === undefined &&
    response.model !== undefined &&
    getAdditionalPropertiesValue(response.model) !== undefined &&
    !isNeverAdditionalProperties(response.model)
  );
}

function responseExposesHandlerProperty(
  ctx: EmitterCtx,
  response: ResponseVariant,
  propertyName: string,
): boolean {
  if (response.headers.some((header) => header.property === propertyName)) return true;
  if (response.bodyProperty !== undefined) return response.bodyProperty === propertyName;

  if (responseHasOpenHandlerProperties(response)) return true;

  const property = getResponseProperty(response, propertyName);
  return property !== undefined && !isResponseDispatchMetadata(ctx, response, propertyName);
}

function emitDirectTypeCondition(ctx: EmitterCtx, response: ResponseVariant): string | undefined {
  const subject = subjectExpr(response);
  if (response.body?.bodyKind === "file") {
    return wrapSubjectGuard(response, `typeof File !== "undefined" && ${subject} instanceof File`);
  }
  if (response.model && isArrayModelType(ctx.program, response.model)) {
    return wrapSubjectGuard(response, `Array.isArray(${subject})`);
  }

  if (response.type.kind === "Intrinsic" && response.type.name === "null") {
    return wrapSubjectGuard(response, `${subject} === null`);
  }

  if (response.type.kind !== "Scalar") return undefined;

  const scalarType = scalarToTs(response.type, getDateTimeMode(ctx));
  if (scalarType === "string") {
    return wrapSubjectGuard(response, `typeof ${subject} === "string"`);
  }
  if (scalarType === "boolean") {
    return wrapSubjectGuard(response, `typeof ${subject} === "boolean"`);
  }
  if (scalarType === "Uint8Array") {
    return wrapSubjectGuard(response, `${subject} instanceof Uint8Array`);
  }
  if (scalarType === "number") {
    return wrapSubjectGuard(response, `typeof ${subject} === "number"`);
  }
  if (scalarType === "bigint") {
    return wrapSubjectGuard(response, `typeof ${subject} === "bigint"`);
  }
  if (scalarType === "Date" || scalarType.startsWith("Temporal.")) {
    return wrapSubjectGuard(response, `${subject} instanceof ${scalarType}`);
  }

  return undefined;
}

/**
 * Expression for the value a dispatcher should test against `result`. For
 * envelope variants (where `@body body: T` wraps the handler-facing shape),
 * predicates must target `result[bodyProperty]` rather than the envelope
 * itself; otherwise property/type checks generated from the body's model
 * would always miss against the envelope object.
 */
function subjectExpr(variant: ResponseVariant): string {
  if (variant.bodyProperty === undefined) return "result";
  return `(result as Record<string, unknown>)[${tsLiteral(variant.bodyProperty)}]`;
}

/**
 * For envelope variants, predicates that inspect the body must also assert
 * the envelope exists. Direct-result variants don't need the extra guard.
 */
function wrapSubjectGuard(variant: ResponseVariant, condition: string): string {
  if (variant.bodyProperty === undefined) return condition;
  return `typeof result === "object" && result !== null && ${tsLiteral(variant.bodyProperty)} in result && ${condition}`;
}

/** Common shape check that the variant's subject is a plain object. */
function emitObjectShapeCondition(variant: ResponseVariant): string {
  const subject = subjectExpr(variant);
  const base = `typeof ${subject} === "object" && ${subject} !== null && !Array.isArray(${subject})`;
  return wrapSubjectGuard(variant, base);
}

function resolveExplicitDiscriminatorBranches(
  ctx: EmitterCtx,
  op: HttpOperation,
  responses: readonly ResponseVariant[],
): ResponseBranch[] | undefined {
  const returnType = op.operation.returnType;
  const discriminator =
    returnType.kind === "Union"
      ? getDiscriminator(ctx.program, returnType)?.propertyName
      : undefined;
  return emitLiteralFieldBranches(
    ctx,
    discriminator ?? findCommonModelDiscriminator(ctx, responses),
    responses,
  );
}

function resolveImplicitLiteralBranches(
  ctx: EmitterCtx,
  responses: readonly ResponseVariant[],
): ResponseBranch[] | undefined {
  const candidateFields = new Set<string>();
  for (const response of responses) {
    for (const prop of getResponseProperties(response)) {
      if (isResponseDispatchMetadata(ctx, response, prop.name)) continue;
      if (isStringLikeLiteral(prop.type) || prop.type.kind === "Number") {
        candidateFields.add(prop.name);
      }
    }
  }

  for (const field of candidateFields) {
    const branches = emitLiteralFieldBranches(ctx, field, responses);
    if (branches) return branches;
  }

  return undefined;
}

function emitLiteralFieldBranches(
  ctx: EmitterCtx,
  field: string | undefined,
  responses: readonly ResponseVariant[],
): ResponseBranch[] | undefined {
  if (!field) return undefined;

  const branches: ResponseBranch[] = [];
  const values = new Set<string>();

  for (const response of responses) {
    const prop = getResponseProperty(response, field);
    if (!prop || prop.optional || isResponseDispatchMetadata(ctx, response, prop.name)) {
      return undefined;
    }
    if (!isStringLikeLiteral(prop.type) && prop.type.kind !== "Number") return undefined;
    const numericValue = prop.type.kind === "Number" ? resolveNumericLiteral(prop.type) : undefined;
    if (numericValue && !numericValue.supported) return undefined;
    const stringValue = isStringLikeLiteral(prop.type)
      ? getStringLiteralValue(prop.type)
      : undefined;
    if (!numericValue && stringValue === undefined) return undefined;
    const valueKey = numericValue ? numericValue.key : `string:${stringValue}`;
    if (values.has(valueKey)) return undefined;
    values.add(valueKey);
    const subject = subjectExpr(response);
    const cast =
      response.bodyProperty === undefined ? subject : `(${subject} as Record<string, unknown>)`;
    const literal =
      prop.type.kind === "Number"
        ? numericLiteralExpression(prop.type)
        : stringLiteralExpression(prop.type);
    const base = `${tsLiteral(field)} in ${cast} && ${cast}[${tsLiteral(field)}] === ${literal}`;
    const guarded =
      response.bodyProperty === undefined
        ? `typeof ${subject} === "object" && ${subject} !== null && ${base}`
        : `${emitObjectShapeCondition(response)} && ${base}`;
    branches.push({ response, condition: guarded });
  }

  return branches;
}

function resolvePropertyBranches(
  ctx: EmitterCtx,
  responses: readonly ResponseVariant[],
): ResponseBranch[] | undefined {
  const modelProps = responses.map((response) => {
    const props = new Set<string>();
    for (const prop of getResponseProperties(response)) {
      if (!prop.optional && !isResponseDispatchMetadata(ctx, response, prop.name)) {
        props.add(prop.name);
      }
    }
    return props;
  });

  const uniqueProperties: string[] = [];
  for (let i = 0; i < responses.length; i++) {
    let uniqueProp: string | undefined;
    for (const prop of modelProps[i]) {
      const isUnique = responses.every(
        (other, j) => j === i || !responseCanMatchPropertyPredicate(ctx, responses[i], other, prop),
      );
      if (isUnique) {
        uniqueProp = prop;
        break;
      }
    }
    if (!uniqueProp) return undefined;
    uniqueProperties.push(uniqueProp);
  }

  const branches: ResponseBranch[] = [];
  for (let i = 0; i < responses.length; i++) {
    const uniqueProp = uniqueProperties[i];
    const excludedProps = uniqueProperties.filter(
      (_, j) => j !== i && responses[j].bodyProperty === responses[i].bodyProperty,
    );
    branches.push({
      response: responses[i],
      condition: emitExclusivePropertyCondition(responses[i], uniqueProp, excludedProps),
    });
  }

  return branches;
}

/**
 * Whether a value of `other` can satisfy the required-property predicate
 * emitted for `candidate`. Properties must be compared at the runtime subject
 * each branch inspects: either the result itself or an explicitly wrapped
 * response body.
 */
function responseCanMatchPropertyPredicate(
  ctx: EmitterCtx,
  candidate: ResponseVariant,
  other: ResponseVariant,
  propertyName: string,
): boolean {
  if (candidate.bodyProperty === undefined) {
    return responseExposesHandlerProperty(ctx, other, propertyName);
  }

  if (other.bodyProperty === candidate.bodyProperty) {
    if (
      other.model &&
      getAdditionalPropertiesValue(other.model) !== undefined &&
      !isNeverAdditionalProperties(other.model)
    ) {
      return true;
    }
    const property = getResponseProperty(other, propertyName);
    return property !== undefined && !isResponseDispatchMetadata(ctx, other, propertyName);
  }

  // A differently shaped result can only reach the candidate's nested
  // subject if it exposes the candidate's wrapper at the top level. Its value
  // could contain any nested marker, so conservatively treat that as overlap.
  return responseExposesHandlerProperty(ctx, other, candidate.bodyProperty);
}

function isClosedEmptyObjectResult(response: ResponseVariant): boolean {
  return (
    response.bodyProperty === undefined &&
    response.tsType === "Record<string, never>" &&
    !responseHasOpenHandlerProperties(response)
  );
}

function appendClosedEmptyObjectBranch(
  branches: readonly ResponseBranch[],
  response: ResponseVariant | undefined,
): ResponseBranch[] {
  if (!response) return [...branches];
  return [
    ...branches,
    {
      response,
      condition: emitClosedEmptyObjectCondition(),
    },
  ];
}

function emitClosedEmptyObjectCondition(): string {
  return [
    `typeof result === "object"`,
    `result !== null`,
    `!Array.isArray(result)`,
    `Reflect.ownKeys(result).length === 0`,
  ].join(" && ");
}

function emitExclusivePropertyCondition(
  response: ResponseVariant,
  requiredProperty: string,
  excludedProperties: readonly string[],
): string {
  const subject = subjectExpr(response);
  const cast =
    response.bodyProperty === undefined ? subject : `(${subject} as Record<string, unknown>)`;
  const propertyChecks = [
    `${tsLiteral(requiredProperty)} in ${cast}`,
    ...excludedProperties.map((prop) => `!(${tsLiteral(prop)} in ${cast})`),
  ];
  if (response.bodyProperty === undefined) {
    return [`typeof ${subject} === "object"`, `${subject} !== null`, ...propertyChecks].join(
      " && ",
    );
  }
  return [emitObjectShapeCondition(response), ...propertyChecks].join(" && ");
}

type BodyShape =
  | "array"
  | "string"
  | "number"
  | "boolean"
  | "bytes"
  | "object"
  | "date"
  | "temporal-plain-date"
  | "temporal-plain-time"
  | "temporal-instant"
  | "temporal-zoned-date-time"
  | "temporal-duration";

/**
 * Dispatch variants whose envelope is a single `body` property and whose
 * body runtime shapes (array vs string vs number vs bytes vs object) are
 * all distinct. Generates `Array.isArray(result.body)` /
 * `typeof result.body === "..."` checks. Returns undefined when fewer than
 * two variants qualify or when two variants share the same body shape.
 */
function resolveEnvelopeBodyShapeBranches(
  ctx: EmitterCtx,
  responses: readonly ResponseVariant[],
): ResponseBranch[] | undefined {
  if (responses.length < 2) return undefined;

  const shapes: BodyShape[] = [];
  for (const response of responses) {
    if (response.isVoid) return undefined;
    if (response.bodyProperty === undefined) return undefined;
    const bodyType = response.type;
    const shape = bodyShapeFor(ctx, bodyType);
    if (!shape) return undefined;
    if (shapes.includes(shape)) return undefined;
    shapes.push(shape);
  }

  return responses.map((response, index) => ({
    response,
    condition: emitBodyShapeCondition(response.bodyProperty!, shapes[index]),
  }));
}

function bodyShapeFor(ctx: EmitterCtx, type: Type): BodyShape | undefined {
  if (type.kind === "Model") {
    if (isArrayModelType(ctx.program, type)) return "array";
    if (isRecordModelType(ctx.program, type)) return "object";
    return "object";
  }
  if (type.kind === "Tuple") return "array";
  if (type.kind === "Scalar") {
    const tsType = scalarToTs(type, getDateTimeMode(ctx));
    if (tsType === "string") return "string";
    if (tsType === "number") return "number";
    if (tsType === "boolean") return "boolean";
    if (tsType === "Uint8Array") return "bytes";
    if (tsType === "Date") return "date";
    if (tsType === "Temporal.PlainDate") return "temporal-plain-date";
    if (tsType === "Temporal.PlainTime") return "temporal-plain-time";
    if (tsType === "Temporal.Instant") return "temporal-instant";
    if (tsType === "Temporal.ZonedDateTime") return "temporal-zoned-date-time";
    if (tsType === "Temporal.Duration") return "temporal-duration";
    return undefined;
  }
  return undefined;
}

function emitBodyShapeCondition(bodyProperty: string, shape: BodyShape): string {
  const body = `(result as Record<string, unknown>)[${tsLiteral(bodyProperty)}]`;
  const guard = `typeof result === "object" && result !== null && ${tsLiteral(bodyProperty)} in result`;
  switch (shape) {
    case "array":
      return `${guard} && Array.isArray(${body})`;
    case "string":
      return `${guard} && typeof ${body} === "string"`;
    case "number":
      return `${guard} && typeof ${body} === "number"`;
    case "boolean":
      return `${guard} && typeof ${body} === "boolean"`;
    case "bytes":
      return `${guard} && ${body} instanceof Uint8Array`;
    case "object":
      return `${guard} && typeof ${body} === "object" && ${body} !== null && !Array.isArray(${body})`;
    case "date":
      return `${guard} && ${body} instanceof Date`;
    case "temporal-plain-date":
      return `${guard} && ${body} instanceof Temporal.PlainDate`;
    case "temporal-plain-time":
      return `${guard} && ${body} instanceof Temporal.PlainTime`;
    case "temporal-instant":
      return `${guard} && ${body} instanceof Temporal.Instant`;
    case "temporal-zoned-date-time":
      return `${guard} && ${body} instanceof Temporal.ZonedDateTime`;
    case "temporal-duration":
      return `${guard} && ${body} instanceof Temporal.Duration`;
  }
}

function isResponseDispatchMetadata(
  ctx: EmitterCtx,
  response: ResponseVariant,
  propertyName: string,
): boolean {
  if (response.hiddenProperties.has(propertyName)) return true;
  const prop = getResponseProperty(response, propertyName);
  return prop !== undefined && isHeader(ctx.program, prop);
}

function findCommonModelDiscriminator(
  ctx: EmitterCtx,
  responses: readonly ResponseVariant[],
): string | undefined {
  const fields = responses.map((response) => findModelDiscriminator(ctx, response.model));
  const [first] = fields;
  if (!first) return undefined;
  return fields.every((field) => field === first) ? first : undefined;
}

function findModelDiscriminator(ctx: EmitterCtx, model: Model | undefined): string | undefined {
  let current = model;
  while (current) {
    const discriminator = getDiscriminator(ctx.program, current);
    if (discriminator) return discriminator.propertyName;
    current = current.baseModel;
  }
  return undefined;
}

function getResponseProperties(response: ResponseVariant): ModelProperty[] {
  return response.model ? [...walkPropertiesInherited(response.model)] : [];
}

function getResponseProperty(
  response: ResponseVariant,
  propertyName: string,
): ModelProperty | undefined {
  return getResponseProperties(response).find((prop) => prop.name === propertyName);
}
