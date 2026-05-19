import type { Model, Type, Union } from "@typespec/compiler";
import { getDiscriminator, isArrayModelType, isErrorModel, isRecordModelType } from "@typespec/compiler";
import type { HttpOperation, HttpOperationResponse } from "@typespec/http";
import { getHeaderFieldName, isHeader, isStatusCode } from "@typespec/http";
import type { EmitterCtx } from "./ctx.js";
import { typeToTs } from "./type-reference.js";

export interface OperationGroup {
  interfaceName?: string;
  propertyName: string;
  operations: HttpOperation[];
}

const BUILTIN_TYPE_NAMES = new Set([
  "Array", "Record", "string", "int32", "int64", "float32", "float64",
  "boolean", "bytes", "plainDate", "utcDateTime", "offsetDateTime",
  "duration", "url", "numeric", "integer", "float", "decimal",
  "void", "null", "never", "unknown",
]);

export function collectModelImports(
  ctx: EmitterCtx,
  operations: HttpOperation[],
): string[] {
  const names = new Set<string>();
  for (const op of operations) {
    collectTypeNames(ctx, op, names);
  }
  return [...names]
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .sort();
}

function collectTypeNames(
  ctx: EmitterCtx,
  op: HttpOperation,
  names: Set<string>,
): void {
  for (const param of op.parameters.parameters) {
    addModelName(ctx, param.param.type, names, new Set());
  }

  if (op.parameters.body?.type) {
    addModelName(ctx, op.parameters.body.type, names, new Set());
  }

  for (const resp of op.responses) {
    addModelName(ctx, resp.type, names, new Set());
    for (const respBody of resp.responses) {
      if (respBody.body?.type) {
        addModelName(ctx, respBody.body.type, names, new Set());
      }
    }
  }
}

function addModelName(
  ctx: EmitterCtx,
  type: Type,
  names: Set<string>,
  seen: Set<Type>,
): void {
  if (seen.has(type)) return;
  seen.add(type);

  if (type.kind === "Model" && typeof type.name === "string" && type.name !== "") {
    if (isArrayModelType(ctx.program, type) || isRecordModelType(ctx.program, type)) {
      if (type.indexer) {
        addModelName(ctx, type.indexer.value, names, seen);
      }
      return;
    }
    if (BUILTIN_TYPE_NAMES.has(type.name)) return;
    names.add(type.name);

    for (const prop of type.properties.values()) {
      addModelName(ctx, prop.type, names, seen);
    }
  }

  if (type.kind === "Union") {
    for (const v of type.variants.values()) {
      addModelName(ctx, v.type, names, seen);
    }
  }

  if (type.kind === "Tuple") {
    for (const value of type.values) {
      addModelName(ctx, value, names, seen);
    }
  }

  if (type.kind === "ModelProperty" || type.kind === "UnionVariant") {
    addModelName(ctx, type.type, names, seen);
  }
}

export function groupOperations(operations: HttpOperation[]): OperationGroup[] {
  const standalone: HttpOperation[] = [];
  const groups = new Map<string, OperationGroup>();

  for (const op of operations) {
    const iface = op.operation.interface;
    if (!iface) {
      standalone.push(op);
      continue;
    }

    if (!groups.has(iface.name)) {
      groups.set(iface.name, {
        interfaceName: iface.name,
        propertyName: iface.name,
        operations: [],
      });
    }

    groups.get(iface.name)!.operations.push(op);
  }

  const ordered: OperationGroup[] = [...groups.values()];
  if (standalone.length > 0) {
    ordered.push({
      propertyName: "__standalone__",
      operations: standalone,
    });
  }

  return ordered;
}

export function buildInputType(ctx: EmitterCtx, op: HttpOperation): string {
  const parts: string[] = [];

  for (const param of op.parameters.parameters) {
    const optional = param.param.optional ? "?" : "";
    parts.push(`${param.param.name}${optional}: ${typeToTs(ctx, param.param.type)}`);
  }

  if (op.parameters.body) {
    const body = op.parameters.body;

    // Multipart body — build type from parts
    if ("bodyKind" in body && body.bodyKind === "multipart" && "parts" in body) {
      const multiParts = (body as any).parts as ReadonlyArray<{ name?: string; body: { type: Type }; optional: boolean; multi: boolean }>;
      for (const part of multiParts) {
        if (!part.name) continue;
        const optional = part.optional ? "?" : "";
        let tsType = typeToTs(ctx, part.body.type);
        if (part.multi) tsType = `${tsType}[]`;
        parts.push(`${part.name}${optional}: ${tsType}`);
      }
    } else {
      const bodyType = body.type;
      if (parts.length === 0 && bodyType.kind === "Model" && bodyType.name) {
        return bodyType.name;
      }

      if (bodyType.kind === "Model") {
        for (const [, prop] of bodyType.properties) {
          const optional = prop.optional ? "?" : "";
          parts.push(`${prop.name}${optional}: ${typeToTs(ctx, prop.type)}`);
        }
      }
    }
  }

  if (parts.length === 0) return "Record<string, never>";
  return `{ ${parts.join("; ")} }`;
}

export function buildSuccessType(ctx: EmitterCtx, op: HttpOperation): string {
  const types: string[] = [];

  for (const resp of op.responses) {
    const isError = resp.type.kind === "Model" && isErrorModel(ctx.program, resp.type);
    if (isError) continue;

    if (resp.type.kind === "Intrinsic" && resp.type.name === "void") {
      types.push("void");
    } else {
      types.push(responseTypeToTs(ctx, resp));
    }
  }

  if (types.length === 0) return "void";
  return types.join(" | ");
}

function responseTypeToTs(ctx: EmitterCtx, resp: HttpOperationResponse): string {
  if (resp.type.kind !== "Model" || !hasResponseEnvelopeMetadata(resp)) {
    return typeToTs(ctx, resp.type);
  }

  const parts: string[] = [];
  for (const prop of resp.type.properties.values()) {
    const optional = prop.optional ? "?" : "";
    parts.push(`${prop.name}${optional}: ${typeToTs(ctx, prop.type)}`);
  }
  return parts.length === 0 ? "Record<string, never>" : `{ ${parts.join("; ")} }`;
}

function hasResponseEnvelopeMetadata(resp: HttpOperationResponse): boolean {
  return resp.responses.some((content) =>
    content.properties.some((prop) =>
      prop.kind === "header" ||
      prop.kind === "statusCode" ||
      prop.kind === "contentType" ||
      prop.kind === "body"
    )
  );
}

export function buildErrorType(ctx: EmitterCtx, op: HttpOperation): string {
  const types: string[] = [];

  for (const resp of op.responses) {
    const isError = resp.type.kind === "Model" && isErrorModel(ctx.program, resp.type);
    if (!isError) continue;
    types.push(typeToTs(ctx, resp.type));
  }

  if (types.length === 0) return "never";
  return types.join(" | ");
}

export function toColonPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

export interface SuccessResponseEncoding {
  readonly statusCode: number;
  readonly isVoid: boolean;
  readonly contentType: string | undefined;
}

export function getSuccessResponseEncoding(
  ctx: EmitterCtx,
  op: HttpOperation,
): SuccessResponseEncoding {
  let successStatus = 200;
  let isVoid = false;
  let contentType: string | undefined;

  for (const resp of op.responses) {
    const isError = resp.type.kind === "Model" && isErrorModel(ctx.program, resp.type);
    if (isError) continue;

    const rawStatus = resp.statusCodes;
    successStatus = typeof rawStatus === "number" ? rawStatus : 200;
    isVoid = resp.type.kind === "Intrinsic" && resp.type.name === "void";

    for (const content of resp.responses) {
      if (content.body?.contentTypes.length) {
        contentType = content.body.contentTypes[0];
      }
    }
    break;
  }

  if (isVoid) {
    return { statusCode: successStatus === 200 ? 204 : successStatus, isVoid: true, contentType };
  }
  return { statusCode: successStatus, isVoid: false, contentType };
}

/** Success response encoder expression used in generated output encoder objects. */
export function emitSuccessResponseEncoder(
  ctx: EmitterCtx,
  op: HttpOperation,
  successType: string,
): string {
  const responses = collectSuccessResponseVariants(ctx, op);
  if (responses.length > 1) {
    const statusField = findStatusDiscriminator(ctx, responses);
    if (statusField) {
      const entries = responses
        .map((response) => `${JSON.stringify(String(response.statusCode))}: ${emitResponseVariant(response)}`)
        .join(", ");
      return `ResponseEncoders.discriminated<${successType}>(${JSON.stringify(statusField)}, { ${entries} }, ${emitResponseVariant(responses[0])})`;
    }
  }

  const response = responses[0] ?? getSuccessResponseEncoding(ctx, op);
  if (response.isVoid) {
    return `ResponseEncoders.empty(${response.statusCode})`;
  }

  if ("omitProperties" in response && shouldUseVariantEncoder(response)) {
    return `ResponseEncoders.variant<${successType}>(${emitResponseVariant(response)})`;
  }

  const headers = response.headers ?? collectResponseHeaders(ctx, op);
  const encoder = pickEncoderForContentType(response.contentType, successType, response.statusCode);

  if (headers.length > 0 && encoder.startsWith("ResponseEncoders.json")) {
    const entries = headers
      .map((h) => `[${JSON.stringify(h.property)}, ${JSON.stringify(h.header)}]`)
      .join(", ");
    return `ResponseEncoders.jsonWithHeaders<${successType}>(${response.statusCode}, [${entries}])`;
  }

  return encoder;
}

function shouldUseVariantEncoder(response: SuccessResponseVariant): boolean {
  return response.bodyProperty !== undefined ||
    response.omitProperties.length > 0;
}

interface SuccessResponseVariant extends SuccessResponseEncoding {
  readonly headers: ResponseHeader[];
  readonly bodyProperty?: string;
  readonly omitProperties: readonly string[];
  readonly statusProperty?: string;
}

function collectSuccessResponseVariants(
  ctx: EmitterCtx,
  op: HttpOperation,
): SuccessResponseVariant[] {
  const variants: SuccessResponseVariant[] = [];

  for (const resp of op.responses) {
    const isError = resp.type.kind === "Model" && isErrorModel(ctx.program, resp.type);
    if (isError) continue;

    const content = resp.responses[0];
    const rawStatus = resp.statusCodes;
    const statusCode = typeof rawStatus === "number"
      ? rawStatus
      : resp.type.kind === "Model"
        ? resolveStatusCodeFromModel(ctx, resp.type) ?? 200
        : 200;
    const isVoid = resp.type.kind === "Intrinsic" && resp.type.name === "void";
    const body = content?.body;
    const contentType = body?.contentTypes[0];
    const headers = collectResponseHeadersFromContent(ctx, content);
    const metadataProperties = content?.properties
      .filter((prop) =>
        prop.kind === "header" ||
        prop.kind === "statusCode" ||
        prop.kind === "contentType" ||
        prop.kind === "body"
      ) ?? [];

    variants.push({
      statusCode: isVoid && statusCode === 200 ? 204 : statusCode,
      isVoid,
      contentType,
      headers,
      bodyProperty: body?.property?.name,
      omitProperties: metadataProperties.map((prop) => prop.property.name),
      statusProperty: metadataProperties.find((prop) => prop.kind === "statusCode")?.property.name,
    });
  }

  return variants;
}

function collectResponseHeadersFromContent(
  ctx: EmitterCtx,
  content: HttpOperationResponse["responses"][number] | undefined,
): ResponseHeader[] {
  if (!content?.headers) return [];
  return Object.values(content.headers)
    .filter((prop) => isHeader(ctx.program, prop))
    .map((prop) => ({
      property: prop.name,
      header: getHeaderFieldName(ctx.program, prop).toLowerCase(),
    }));
}

function findStatusDiscriminator(
  ctx: EmitterCtx,
  responses: readonly SuccessResponseVariant[],
): string | undefined {
  const [first] = responses;
  if (!first?.statusProperty) return undefined;
  if (!responses.every((response) => response.statusProperty === first.statusProperty)) {
    return undefined;
  }

  const statuses = new Set(responses.map((response) => response.statusCode));
  return statuses.size === responses.length ? first.statusProperty : undefined;
}

function emitResponseVariant(response: SuccessResponseVariant): string {
  const fields = [`status: ${response.statusCode}`];
  const kind = pickVariantKind(response);
  if (kind !== "json") fields.push(`kind: ${JSON.stringify(kind)}`);
  if (response.contentType) fields.push(`contentType: ${JSON.stringify(response.contentType)}`);
  if (response.bodyProperty) fields.push(`body: ${JSON.stringify(response.bodyProperty)}`);
  if (response.headers.length > 0) {
    const headers = response.headers
      .map((h) => `[${JSON.stringify(h.property)}, ${JSON.stringify(h.header)}]`)
      .join(", ");
    fields.push(`headers: [${headers}]`);
  }
  if (response.omitProperties.length > 0) {
    fields.push(`omit: [${response.omitProperties.map((name) => JSON.stringify(name)).join(", ")}]`);
  }
  return `{ ${fields.join(", ")} }`;
}

function pickVariantKind(response: SuccessResponseVariant): "json" | "text" | "bytes" | "empty" {
  if (response.isVoid) return "empty";
  if (!response.contentType || response.contentType.includes("json")) return "json";
  if (response.contentType === "text/plain" || response.contentType.startsWith("text/")) return "text";
  if (response.contentType === "application/octet-stream") return "bytes";
  return "json";
}

function pickEncoderForContentType(contentType: string | undefined, tsType: string, status: number): string {
  if (!contentType || contentType.includes("json")) {
    return `ResponseEncoders.json<${tsType}>(${status})`;
  }
  if (contentType === "text/plain" || contentType.startsWith("text/")) {
    return `ResponseEncoders.text(${status})`;
  }
  if (contentType === "application/octet-stream") {
    return `ResponseEncoders.bytes(${status})`;
  }
  return `ResponseEncoders.json<${tsType}>(${status})`;
}

interface ResponseHeader {
  readonly property: string;
  readonly header: string;
}

/** Collects @header-decorated properties from the success response type. */
function collectResponseHeaders(ctx: EmitterCtx, op: HttpOperation): ResponseHeader[] {
  const headers: ResponseHeader[] = [];

  for (const resp of op.responses) {
    if (resp.type.kind === "Model" && isErrorModel(ctx.program, resp.type)) continue;
    if (resp.type.kind !== "Model") continue;

    for (const [, prop] of resp.type.properties) {
      if (isHeader(ctx.program, prop)) {
        const headerName = getHeaderFieldName(ctx.program, prop);
        headers.push({
          property: prop.name,
          header: headerName.toLowerCase(),
        });
      }
    }
    break;
  }

  return headers;
}

/** Collects @header-decorated properties from a single model. */
function collectModelHeaders(ctx: EmitterCtx, model: Model): ResponseHeader[] {
  const headers: ResponseHeader[] = [];
  for (const [, prop] of model.properties) {
    if (isHeader(ctx.program, prop)) {
      headers.push({
        property: prop.name,
        header: getHeaderFieldName(ctx.program, prop).toLowerCase(),
      });
    }
  }
  return headers;
}

/** Emits an error encoder expression for a grouped errors object. */
export function emitErrorEncoderExpression(
  ctx: EmitterCtx,
  op: HttpOperation,
  errorType: string,
): string {
  const errorResponses = collectErrorResponses(ctx, op);

  if (errorResponses.length === 0) {
    return `ErrorEncoders.json<never>(500)`;
  }

  // Single error type — no discrimination needed
  if (errorResponses.length === 1) {
    const headers = collectModelHeaders(ctx, errorResponses[0].model);
    if (headers.length > 0) {
      const entries = headers
        .map((h) => `[${JSON.stringify(h.property)}, ${JSON.stringify(h.header)}]`)
        .join(", ");
      return `ErrorEncoders.jsonWithHeaders<${errorType}>(${errorResponses[0].statusCode}, [${entries}])`;
    }
    return `ErrorEncoders.json<${errorType}>(${errorResponses[0].statusCode})`;
  }

  // Multiple error types — need runtime discrimination
  // Priority 1: @discriminator or unique literal field values
  const discriminant = resolveDiscriminant(ctx, op, errorResponses);
  if (discriminant) {
    const entries = discriminant.variants
      .map((v) => {
        const model = errorResponses.find((e) => e.statusCode === v.status)?.model;
        return `${JSON.stringify(v.value)}: ${emitErrorVariantValue(ctx, v.status, model)}`;
      })
      .join(", ");
    return `ErrorEncoders.discriminated<${errorType}>(${JSON.stringify(discriminant.field)}, { ${entries} })`;
  }

  // Priority 2: unique property existence
  const propertyMapping = findUniquePropertyMapping(ctx, errorResponses);
  if (propertyMapping) {
    const entries = propertyMapping
      .map((e) => {
        const model = errorResponses.find((r) => r.statusCode === e.status)?.model;
        return `${JSON.stringify(e.property)}: ${emitErrorVariantValue(ctx, e.status, model)}`;
      })
      .join(", ");
    return `ErrorEncoders.byProperty<${errorType}>({ ${entries} })`;
  }

  // Fallback — no discrimination possible
  return `ErrorEncoders.json<${errorType}>(${errorResponses[0].statusCode})`;
}

/** Emits a variant value: plain status number or { status, headers } object. */
function emitErrorVariantValue(ctx: EmitterCtx, status: number, model?: Model): string {
  if (!model) return String(status);
  const headers = collectModelHeaders(ctx, model);
  if (headers.length === 0) return String(status);
  const entries = headers
    .map((h) => `[${JSON.stringify(h.property)}, ${JSON.stringify(h.header)}]`)
    .join(", ");
  return `{ status: ${status}, headers: [${entries}] }`;
}

// ---------------------------------------------------------------------------
// Error response collection
// ---------------------------------------------------------------------------

interface ErrorResponse {
  readonly statusCode: number;
  readonly model: Model;
}

function collectErrorResponses(ctx: EmitterCtx, op: HttpOperation): ErrorResponse[] {
  const results: ErrorResponse[] = [];

  for (const resp of op.responses) {
    if (resp.type.kind !== "Model" || !isErrorModel(ctx.program, resp.type)) continue;

    const statusCode = typeof resp.statusCodes === "number"
      ? resp.statusCodes
      : resolveStatusCodeFromModel(ctx, resp.type) ?? 500;

    results.push({ statusCode, model: resp.type });
  }

  return results;
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


// ---------------------------------------------------------------------------
// Discriminant resolution — respects TypeSpec's @discriminator and union semantics
// ---------------------------------------------------------------------------

interface DiscriminantMapping {
  readonly field: string;
  readonly variants: ReadonlyArray<{ value: string; status: number }>;
}

function resolveDiscriminant(
  ctx: EmitterCtx,
  op: HttpOperation,
  errorResponses: ErrorResponse[],
): DiscriminantMapping | undefined {
  // 1. Check for @discriminator on the operation's return type (if it's a union)
  const returnType = op.operation.returnType;
  if (returnType.kind === "Union") {
    const disc = getDiscriminator(ctx.program, returnType);
    if (disc) {
      return buildMappingFromField(ctx, disc.propertyName, errorResponses);
    }
  }

  // 2. Find a property with a unique literal value across ALL error variants
  return findImplicitDiscriminant(ctx, errorResponses);
}

/** Builds a discriminant mapping from a known field name. */
function buildMappingFromField(
  ctx: EmitterCtx,
  field: string,
  errorResponses: ErrorResponse[],
): DiscriminantMapping | undefined {
  const variants: Array<{ value: string; status: number }> = [];

  for (const err of errorResponses) {
    const prop = err.model.properties.get(field);
    if (!prop) return undefined;
    if (isStatusCode(ctx.program, prop)) return undefined; // skip metadata
    if (prop.type.kind !== "String" && prop.type.kind !== "Number") return undefined;
    variants.push({ value: String(prop.type.value), status: err.statusCode });
  }

  // All variants must have unique values
  const values = new Set(variants.map((v) => v.value));
  if (values.size !== variants.length) return undefined;

  return { field, variants };
}

/** Finds a property with a unique literal value in every error model. */
function findImplicitDiscriminant(
  ctx: EmitterCtx,
  errorResponses: ErrorResponse[],
): DiscriminantMapping | undefined {
  // Collect all candidate fields (properties with literal types), skipping metadata
  const candidateFields = new Set<string>();
  for (const err of errorResponses) {
    for (const [, prop] of err.model.properties) {
      if (isStatusCode(ctx.program, prop)) continue;
      if (prop.type.kind === "String" || prop.type.kind === "Number") {
        candidateFields.add(prop.name);
      }
    }
  }

  // Find a field where EVERY error model has a unique literal value
  for (const field of candidateFields) {
    const mapping = buildMappingFromField(ctx, field, errorResponses);
    if (mapping) return mapping;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Unique property existence — fallback when no literal discriminant exists
// ---------------------------------------------------------------------------

interface PropertyMapping {
  readonly property: string;
  readonly status: number;
}

/**
 * Finds a required property unique to each error model.
 * Mirrors the official http-server-js emitter's "unique property existence" strategy.
 */
function findUniquePropertyMapping(
  ctx: EmitterCtx,
  errorResponses: ErrorResponse[],
): PropertyMapping[] | undefined {
  const allPropertyNames = new Set<string>();
  const modelProps = errorResponses.map((err) => {
    const props = new Set<string>();
    for (const [, prop] of err.model.properties) {
      if (!prop.optional && !isStatusCode(ctx.program, prop)) {
        props.add(prop.name);
        allPropertyNames.add(prop.name);
      }
    }
    return props;
  });

  const mapping: PropertyMapping[] = [];

  for (let i = 0; i < errorResponses.length; i++) {
    let uniqueProp: string | undefined;

    for (const prop of modelProps[i]) {
      // Check that no other model has this property
      const isUnique = modelProps.every((otherProps, j) => j === i || !otherProps.has(prop));
      if (isUnique) {
        uniqueProp = prop;
        break;
      }
    }

    if (!uniqueProp) return undefined; // Can't differentiate all models
    mapping.push({ property: uniqueProp, status: errorResponses[i].statusCode });
  }

  return mapping;
}
