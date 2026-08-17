/**
 * Plans handler-facing response types, variants, status, body, and header metadata.
 */
import type { Model, ModelProperty, Type } from "@typespec/compiler";
import { isErrorModel } from "@typespec/compiler";
import type {
  HttpOperation,
  HttpOperationResponse,
  HttpOperationResponseContent,
  HttpPayloadBody,
  HttpStatusCodeRange,
} from "@typespec/http";
import {
  getHeaderFieldName,
  getHeaderFieldOptions,
  getStatusCodes,
  isStatusCode,
} from "@typespec/http";
import { getStreamMetadata } from "@typespec/http/experimental";
import type { EmitterCtx } from "./ctx.js";
import { dateTimeScalarNeedsTransform } from "./datetime-mode.js";
import { propertiesShareSource } from "./http-models.js";
import {
  emitJsonWireSerializer,
  unsupportedJsonWireTransformReason,
} from "./json-wire-transforms.js";
import { $lib } from "./lib.js";
import { getAdditionalPropertiesValue, isNeverAdditionalProperties } from "./model-indexer.js";
import {
  getPayloadBodyContext,
  getPayloadCollection,
  getResponseBodyProjection,
  payloadModelProperties,
  payloadProjectionChangesType,
  payloadPropertyOptional,
  payloadTypeToTs,
  type PayloadProjection,
} from "./payload-context.js";
import { resolveScalarEncoding } from "./scalar-encoding.js";
import { shouldFlattenBodyType } from "./request-input-plan.js";
import {
  isTemplatedScalarReference,
  isTemplatedUnionReference,
  typeToTs,
} from "./type-reference.js";
import { tsLiteral, tsPropertyAccess, tsPropertyDeclaration } from "./typescript-names.js";

export function buildResultType(ctx: EmitterCtx, op: HttpOperation): string {
  const sourceAlias = operationReturnAliasToTs(ctx, op);
  if (sourceAlias) return sourceAlias;

  const types: string[] = [];
  const seen = new Set<string>();

  for (const resp of op.responses) {
    if (resp.type.kind === "Intrinsic" && resp.type.name === "void") {
      if (!seen.has("void")) {
        types.push("void");
        seen.add("void");
      }
      continue;
    }
    // Expand same-status responses with multiple content types into one TS
    // type per content entry — see collectResponseVariants for the same loop.
    const contents = resp.responses.length > 0 ? resp.responses : [undefined];
    for (const content of contents) {
      const tsType = content
        ? responseContentToTs(ctx, op, resp, content)
        : responseTypeToTs(ctx, resp);
      if (!seen.has(tsType)) {
        types.push(tsType);
        seen.add(tsType);
      }
    }
  }

  if (types.length === 0) return "void";
  return types.join(" | ");
}

function operationReturnAliasToTs(ctx: EmitterCtx, op: HttpOperation): string | undefined {
  if (op.responses.length !== 1) return undefined;
  const [response] = op.responses;
  if (response.responses.length !== 1 || hasResponseEnvelopeMetadata(response)) {
    return undefined;
  }

  const [content] = response.responses;
  const body = content?.body;
  if (
    !body ||
    payloadProjectionChangesType(ctx, body.type, getResponseBodyProjection(ctx, op, content))
  ) {
    return undefined;
  }

  const returnType = op.operation.returnType;
  if (returnType.kind === "Union" && isTemplatedUnionReference(returnType)) {
    // Preserve source aliases only when TypeSpec HTTP produced one response
    // surface. Multi-response unions need normalized response shapes so status,
    // body, and header variants stay visible to handlers and encoders.
    return typeToTs(ctx, returnType);
  }
  if (returnType.kind === "Scalar" && isTemplatedScalarReference(returnType)) {
    return typeToTs(ctx, returnType);
  }
  return undefined;
}

function responseTypeToTs(ctx: EmitterCtx, resp: HttpOperationResponse): string {
  if (resp.type.kind !== "Model" || !hasResponseEnvelopeMetadata(resp)) {
    return typeToTs(ctx, resp.type);
  }

  const hiddenProperties = getHiddenResponsePropertyNames(ctx, resp);
  const parts: string[] = [];
  for (const prop of resp.type.properties.values()) {
    if (hiddenProperties.has(prop.name)) continue;
    parts.push(
      tsPropertyDeclaration(prop.name, typeToTs(ctx, prop.type), {
        optional: prop.optional,
      }),
    );
  }
  return parts.length === 0 ? "Record<string, never>" : `{ ${parts.join("; ")} }`;
}

function hasResponseEnvelopeMetadata(resp: HttpOperationResponse): boolean {
  return resp.responses.some((content) =>
    content.properties.some(
      (prop) =>
        prop.kind === "header" ||
        prop.kind === "statusCode" ||
        prop.kind === "contentType" ||
        prop.kind === "body" ||
        prop.kind === "bodyRoot",
    ),
  );
}

function getHiddenResponsePropertyNames(ctx: EmitterCtx, resp: HttpOperationResponse): Set<string> {
  const hidden = new Set<string>();
  for (const content of resp.responses) {
    for (const prop of content.properties) {
      if (
        prop.kind === "contentType" ||
        (prop.kind === "statusCode" && !isDynamicStatusProperty(ctx, prop.property))
      ) {
        hidden.add(prop.property.name);
      }
    }
  }
  return hidden;
}

export function reportUnsupportedResponseStatusContracts(
  ctx: EmitterCtx,
  operations: readonly HttpOperation[],
): void {
  for (const op of operations) {
    const checkedProperties = new Set<ModelProperty>();
    for (const response of op.responses) {
      const statusProperties = response.responses.flatMap((content) =>
        content.properties
          .filter((property) => property.kind === "statusCode")
          .map((property) => property.property),
      );

      if (statusProperties.length === 0) {
        if (response.statusCodes === "*") {
          if (!isErrorResponseModel(ctx, response)) {
            reportUnsupportedStatus(
              ctx,
              op,
              'wildcard status "*" has no @statusCode property that can provide the actual response status',
            );
          }
        } else if (typeof response.statusCodes === "object") {
          reportUnsupportedStatus(
            ctx,
            op,
            `range ${formatStatusContract(response.statusCodes)} has no @statusCode property that can provide the actual response status`,
          );
        } else {
          const reason = unsupportedFetchStatusReason(response.statusCodes);
          if (reason) reportUnsupportedStatus(ctx, op, reason);
        }
        continue;
      }

      for (const property of statusProperties) {
        if (checkedProperties.has(property)) continue;
        checkedProperties.add(property);
        for (const status of getStatusCodes(ctx.program, property)) {
          if (status === "*") {
            reportUnsupportedStatus(
              ctx,
              op,
              'wildcard status "*" cannot be selected by Fetch Response',
              property,
            );
            continue;
          }
          const reason = unsupportedFetchStatusReason(status);
          if (reason) reportUnsupportedStatus(ctx, op, reason, property);
        }
      }
    }
  }
}

function unsupportedFetchStatusReason(status: ResponseStatusContract): string | undefined {
  if (typeof status === "number") {
    return Number.isInteger(status) && status >= 200 && status <= 599
      ? undefined
      : `status ${status} is outside Fetch Response's supported integer range 200–599`;
  }
  return Number.isInteger(status.start) &&
    Number.isInteger(status.end) &&
    status.start >= 200 &&
    status.end <= 599 &&
    status.start <= status.end
    ? undefined
    : `range ${formatStatusContract(status)} is outside Fetch Response's supported integer range 200–599`;
}

function formatStatusContract(status: HttpStatusCodeRange): string {
  return `${status.start}–${status.end}`;
}

function isErrorResponseModel(ctx: EmitterCtx, response: HttpOperationResponse): boolean {
  return response.type.kind === "Model" && isErrorModel(ctx.program, response.type);
}

function reportUnsupportedStatus(
  ctx: EmitterCtx,
  op: HttpOperation,
  reason: string,
  target: ModelProperty | undefined = undefined,
): void {
  $lib.reportDiagnostic(ctx.program, {
    code: "unsupported-response-status-code",
    format: { operationName: op.operation.name, reason },
    target: target ?? op.operation,
  });
}

export interface ResponseVariant {
  readonly statusCode: number;
  readonly dynamicStatus?: DynamicResponseStatusPlan;
  readonly isVoid: boolean;
  readonly hasBody: boolean;
  readonly body?: HttpPayloadBody;
  readonly contentType: string | undefined;
  readonly fileContentTypes: readonly string[];
  readonly fileContentTypeRequired: boolean;
  readonly fileNameRequired: boolean;
  readonly emitFileContentDisposition: boolean;
  readonly headers: ResponseHeader[];
  readonly bodyProperty?: string;
  readonly omitProperties: readonly string[];
  readonly type: Type;
  readonly streamType?: Type;
  readonly model?: Model;
  readonly tsType: string;
  readonly hiddenProperties: ReadonlySet<string>;
  readonly serializationType?: Type;
  readonly projection?: PayloadProjection;
}

export interface ResponseHeader {
  readonly property: string;
  readonly header: string;
  readonly explode: boolean;
  readonly transform?: string;
}

export type ResponseStatusContract = number | HttpStatusCodeRange;

export interface DynamicResponseStatusPlan {
  readonly property: ModelProperty;
  readonly allowed: readonly ResponseStatusContract[];
}

export function collectResponseVariants(ctx: EmitterCtx, op: HttpOperation): ResponseVariant[] {
  const variants: ResponseVariant[] = [];

  for (const resp of op.responses) {
    const statusCode = resolveResponseStatusCode(ctx, resp);
    const isVoid = resp.type.kind === "Intrinsic" && resp.type.name === "void";
    const hiddenProperties = getHiddenResponsePropertyNames(ctx, resp);

    if (isVoid || resp.responses.length === 0) {
      variants.push({
        statusCode: isVoid && statusCode === 200 ? 204 : statusCode,
        isVoid,
        hasBody: false,
        contentType: undefined,
        fileContentTypes: [],
        fileContentTypeRequired: false,
        fileNameRequired: false,
        emitFileContentDisposition: true,
        headers: [],
        omitProperties: [],
        type: resp.type,
        streamType: undefined,
        model: resp.type.kind === "Model" ? resp.type : undefined,
        tsType: isVoid ? "void" : responseTypeToTs(ctx, resp),
        hiddenProperties,
        serializationType: undefined,
        projection: undefined,
      });
      continue;
    }

    // One variant per (content entry × declared content type). TypeSpec
    // collapses same-status responses into a single HttpOperationResponse
    // with multiple `responses` entries, AND a single content entry can
    // declare multiple media types (e.g. via `@header contentType: "json" | "csv"`).
    // Without this expansion the emitter would silently drop everything but
    // the first.
    for (const content of resp.responses) {
      const body = content.body;
      const streamType = getStreamMetadata(ctx.program, content)?.streamType;
      const dynamicStatus = getDynamicResponseStatusPlan(ctx, content);
      const projection = body ? getResponseBodyProjection(ctx, op, content) : undefined;
      const bodyProperty = getResponseBodyProperty(ctx, content, projection);
      const emitFileContentDisposition =
        body?.bodyKind !== "file" || !isFileNameResponseHeader(body, content);
      const declaredContentTypes =
        body?.bodyKind === "file"
          ? [undefined]
          : body?.contentTypes.length
            ? body.contentTypes
            : [undefined];
      const headers = collectResponseHeadersFromContent(ctx, op, content);
      const metadataProperties = content.properties.filter(
        (prop) =>
          prop.kind === "header" ||
          prop.kind === "statusCode" ||
          prop.kind === "contentType" ||
          prop.kind === "body",
      );
      // Per-content variant gets the body's own model when available, so the
      // property-based dispatcher can find fields unique to this variant.
      // Same-status, same-CT shapes with different bodies need this to avoid
      // collapsing to a single shared model.
      const variantModel = body?.type.kind === "Model" ? body.type : undefined;
      const serializationType = getResponseSerializationType(resp, content);

      for (const contentType of declaredContentTypes) {
        variants.push({
          statusCode,
          dynamicStatus,
          isVoid: false,
          hasBody: body !== undefined,
          body,
          contentType,
          fileContentTypes: body?.bodyKind === "file" ? body.contentTypes : [],
          fileContentTypeRequired: body?.bodyKind === "file" && !body.contentTypeProperty.optional,
          fileNameRequired:
            body?.bodyKind === "file" && !body.filename.optional && emitFileContentDisposition,
          emitFileContentDisposition,
          headers,
          bodyProperty,
          omitProperties: metadataProperties.map((prop) => prop.property.name),
          type: body?.type ?? resp.type,
          streamType,
          model: variantModel,
          tsType: responseContentToTs(ctx, op, resp, content),
          hiddenProperties,
          serializationType: streamType ?? serializationType,
          projection,
        });
      }
    }
  }

  return deduplicateDynamicStatusVariants(variants);
}

function isFileNameResponseHeader(
  body: Extract<HttpPayloadBody, { bodyKind: "file" }>,
  content: HttpOperationResponseContent,
): boolean {
  return content.properties.some(
    (property) =>
      property.kind === "header" && propertiesShareSource(property.property, body.filename),
  );
}

function getDynamicResponseStatusPlan(
  ctx: EmitterCtx,
  content: HttpOperationResponseContent,
): DynamicResponseStatusPlan | undefined {
  const property = content.properties.find(
    (candidate) => candidate.kind === "statusCode",
  )?.property;
  if (!property) return undefined;

  const allowed = getStatusCodes(ctx.program, property).filter(
    (status): status is ResponseStatusContract => status !== "*",
  );
  if (allowed.length === 1 && typeof allowed[0] === "number") return undefined;
  return allowed.length > 0 ? { property, allowed } : undefined;
}

function isDynamicStatusProperty(ctx: EmitterCtx, property: ModelProperty): boolean {
  const allowed = getStatusCodes(ctx.program, property);
  return allowed.length !== 1 || typeof allowed[0] !== "number";
}

function deduplicateDynamicStatusVariants(variants: readonly ResponseVariant[]): ResponseVariant[] {
  const deduplicated: ResponseVariant[] = [];
  for (const variant of variants) {
    if (
      variant.dynamicStatus &&
      deduplicated.some(
        (existing) =>
          existing.dynamicStatus?.property === variant.dynamicStatus?.property &&
          existing.tsType === variant.tsType &&
          existing.hasBody === variant.hasBody &&
          existing.streamType === variant.streamType &&
          existing.body?.bodyKind === variant.body?.bodyKind &&
          existing.contentType === variant.contentType &&
          stringArraysEqual(existing.fileContentTypes, variant.fileContentTypes) &&
          existing.bodyProperty === variant.bodyProperty &&
          stringArraysEqual(existing.omitProperties, variant.omitProperties) &&
          responseHeadersEqual(existing.headers, variant.headers),
      )
    ) {
      continue;
    }
    deduplicated.push(variant);
  }
  return deduplicated;
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function responseHeadersEqual(
  left: readonly ResponseHeader[],
  right: readonly ResponseHeader[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (value, index) =>
        value.property === right[index]?.property &&
        value.header === right[index]?.header &&
        value.explode === right[index]?.explode &&
        value.transform === right[index]?.transform,
    )
  );
}

/**
 * Handler-facing TypeScript type for a single content variant of a response.
 * For a single-content response with no envelope metadata, this is just the
 * underlying body type. Otherwise it's an envelope `{ body: T; ...headers }`
 * synthesized from this content's body and the response model's metadata.
 * Fixed status and content type values are stripped; a ranged/union status is
 * retained because the handler supplies the concrete response status.
 */
function responseContentToTs(
  ctx: EmitterCtx,
  op: HttpOperation,
  resp: HttpOperationResponse,
  content: HttpOperationResponse["responses"][number],
): string {
  const body = content.body;
  const headers = content.properties.filter((property) => property.kind === "header");
  const dynamicStatus = getDynamicResponseStatusPlan(ctx, content);
  const projection = body ? getResponseBodyProjection(ctx, op, content) : undefined;
  const streamType = getStreamMetadata(ctx.program, content)?.streamType;
  if (streamType) {
    return `AsyncIterable<${payloadTypeToTs(ctx, streamType, projection)}>`;
  }
  const bodyProperty = getResponseBodyProperty(ctx, content, projection);
  if (!body) {
    const parts: string[] = [];
    if (dynamicStatus) {
      parts.push(
        tsPropertyDeclaration(
          dynamicStatus.property.name,
          typeToTs(ctx, dynamicStatus.property.type),
          { optional: false },
        ),
      );
    }
    parts.push(...responsePropertyDeclarations(ctx, headers));
    return objectTypeFromParts(parts);
  }

  const bodyContext = getPayloadBodyContext(body, content.properties);

  if (!bodyProperty && bodyContext !== "explicit" && headers.length === 0 && !dynamicStatus) {
    // A single implicit response can project the named source model directly.
    // TypeSpec often gives `content.body.type` as an already-filtered anonymous
    // model, which would otherwise discard reusable recursive/generic identity.
    const sourceBodyType = getResponseSerializationType(resp, content) ?? body.type;
    return payloadTypeToTs(ctx, sourceBodyType, projection);
  }

  const parts: string[] = [];
  if (bodyProperty) {
    parts.push(
      tsPropertyDeclaration(bodyProperty, payloadTypeToTs(ctx, body.type, projection), {
        optional: body.property?.optional === true,
      }),
    );
  } else if (shouldFlattenBodyType(ctx, body.type)) {
    for (const property of payloadModelProperties(body.type, projection)) {
      parts.push(
        tsPropertyDeclaration(property.name, payloadTypeToTs(ctx, property.type, projection), {
          optional:
            body.property?.optional === true || payloadPropertyOptional(property, projection),
        }),
      );
    }
  } else if (headers.length === 0) {
    return payloadTypeToTs(ctx, body.type, projection);
  } else {
    parts.push(
      tsPropertyDeclaration("body", payloadTypeToTs(ctx, body.type, projection), {
        optional: body.property?.optional === true,
      }),
    );
  }

  if (dynamicStatus) {
    parts.push(
      tsPropertyDeclaration(
        dynamicStatus.property.name,
        typeToTs(ctx, dynamicStatus.property.type),
        { optional: false },
      ),
    );
  }

  for (const header of headers) {
    parts.push(
      tsPropertyDeclaration(header.property.name, typeToTs(ctx, header.property.type), {
        optional: header.property.optional,
      }),
    );
  }
  return objectTypeFromParts(parts);
}

/** Semantic handler value that becomes the JSON body after HTTP metadata is removed. */
function getResponseSerializationType(
  resp: HttpOperationResponse,
  content: HttpOperationResponseContent,
): Type | undefined {
  const body = content.body;
  if (!body) return undefined;

  const bodyContext = getPayloadBodyContext(body, content.properties);
  if (bodyContext === "implicit" && resp.responses.length === 1 && resp.type.kind === "Model") {
    return resp.type;
  }
  return body.type;
}

/**
 * Selects an envelope property when flattening a `@bodyRoot` payload would
 * collide with response metadata. Keeping the body nested preserves both
 * values and prevents metadata omission from deleting a same-named body
 * field during serialization.
 */
function getResponseBodyProperty(
  ctx: EmitterCtx,
  content: HttpOperationResponseContent,
  projection: PayloadProjection | undefined,
): string | undefined {
  const body = content.body;
  if (!body) return undefined;
  if (body.bodyKind === "file") {
    const hasVisibleMetadata = content.properties.some(
      (property) =>
        property.kind === "header" ||
        (property.kind === "statusCode" && isDynamicStatusProperty(ctx, property.property)),
    );
    return hasVisibleMetadata ? (body.property?.name ?? "body") : undefined;
  }
  if (body.bodyKind !== "single") return undefined;

  const bodyContext = getPayloadBodyContext(body, content.properties);
  if (bodyContext === "explicit") return body.property?.name ?? "body";
  if (bodyContext !== "root" || !body.property) return undefined;

  const metadataNames = new Set(
    content.properties
      .filter(
        (property) =>
          property.kind === "header" ||
          property.kind === "statusCode" ||
          property.kind === "contentType",
      )
      .map((property) => property.property.name),
  );
  if (metadataNames.size === 0) return undefined;

  if (!shouldFlattenBodyType(ctx, body.type)) return body.property.name;

  const additionalProperties = getAdditionalPropertiesValue(body.type);
  if (additionalProperties && !isNeverAdditionalProperties(body.type)) {
    return body.property.name;
  }

  const collides = payloadModelProperties(body.type, projection).some((property) =>
    metadataNames.has(property.name),
  );
  return collides ? body.property.name : undefined;
}

function collectResponseHeadersFromContent(
  ctx: EmitterCtx,
  op: HttpOperation,
  content: HttpOperationResponse["responses"][number] | undefined,
): ResponseHeader[] {
  if (!content) return [];
  return content.properties
    .filter((property) => property.kind === "header")
    .map(({ property }) => ({
      property: property.name,
      header: getHeaderFieldName(ctx.program, property).toLowerCase(),
      explode: getHeaderFieldOptions(ctx.program, property).explode === true,
      transform: emitResponseHeaderTransform(ctx, op, property),
    }));
}

function emitResponseHeaderTransform(
  ctx: EmitterCtx,
  op: HttpOperation,
  property: ModelProperty,
): string | undefined {
  if (!headerTypeHasScalarEncoding(ctx, property.type, property)) return undefined;
  const reason = unsupportedJsonWireTransformReason(
    ctx,
    property.type,
    undefined,
    new Set(),
    property,
  );
  if (reason) {
    $lib.reportDiagnostic(ctx.program, {
      code: "unsupported-response-header",
      format: {
        header: getHeaderFieldName(ctx.program, property).toLowerCase(),
        operation: op.operation.name,
        reason,
      },
      target: property,
    });
    return undefined;
  }
  const serializer = emitJsonWireSerializer(ctx, property.type, undefined, property, "header");
  if (!serializer) return undefined;
  const type = typeToTs(ctx, property.type);
  const path = tsPropertyAccess("$response", property.name);
  return `(value) => ${serializer}.serialize(value as ${type}, ${tsLiteral(path)})`;
}

function headerTypeHasScalarEncoding(ctx: EmitterCtx, type: Type, target?: ModelProperty): boolean {
  switch (type.kind) {
    case "Scalar":
      return (
        dateTimeScalarNeedsTransform(ctx, type) ||
        resolveScalarEncoding(ctx, type, target, "header").status === "supported"
      );
    case "Model": {
      const collection = getPayloadCollection(ctx, type);
      return collection?.kind === "array"
        ? headerTypeHasScalarEncoding(ctx, collection.value, target)
        : false;
    }
    case "Tuple":
      return type.values.some((value) => headerTypeHasScalarEncoding(ctx, value, target));
    case "Union": {
      const variants = [...type.variants.values()].filter(
        (variant) => variant.type.kind !== "Intrinsic" || variant.type.name !== "null",
      );
      return variants.some((variant) => headerTypeHasScalarEncoding(ctx, variant.type, target));
    }
    default:
      return false;
  }
}

function responsePropertyDeclarations(
  ctx: EmitterCtx,
  properties: readonly HttpOperationResponse["responses"][number]["properties"][number][],
): string[] {
  return properties.map(({ property }) =>
    tsPropertyDeclaration(property.name, typeToTs(ctx, property.type), {
      optional: property.optional,
    }),
  );
}

function objectTypeFromParts(parts: readonly string[]): string {
  return parts.length > 0 ? `{ ${parts.join("; ")} }` : "Record<string, never>";
}

/**
 * Concrete status code for a response variant. Numeric statusCodes win, then
 * a literal @statusCode property on the model. Wildcard responses — what
 * TypeSpec assigns an @error model with no explicit status — fall back to
 * 500 rather than 200: an error encoded as success is worse than a generic
 * server error.
 */
function resolveResponseStatusCode(ctx: EmitterCtx, resp: HttpOperationResponse): number {
  if (typeof resp.statusCodes === "number") return resp.statusCodes;
  if (resp.type.kind !== "Model") return 200;
  const declared = resolveStatusCodeFromModel(ctx, resp.type);
  if (declared !== undefined) return declared;
  return isErrorResponseModel(ctx, resp) ? 500 : 200;
}

/** Resolves status code from a @statusCode property on the model. */
function resolveStatusCodeFromModel(ctx: EmitterCtx, model: Model): number | undefined {
  for (const [, prop] of model.properties) {
    if (isStatusCode(ctx.program, prop) && prop.type.kind === "Number") {
      return prop.type.value;
    }
  }
  return undefined;
}
