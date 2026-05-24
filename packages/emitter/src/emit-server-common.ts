import type { Model, ModelProperty, Type } from "@typespec/compiler";
import {
  getDiscriminator,
  isArrayModelType,
  isRecordModelType,
  isType,
  walkPropertiesInherited,
} from "@typespec/compiler";
import type { HttpOperation, HttpOperationResponse } from "@typespec/http";
import { getHeaderFieldName, isHeader, isStatusCode } from "@typespec/http";
import type { EmitterCtx } from "./ctx.js";
import { $lib } from "./lib.js";
import { typeToTs } from "./type-reference.js";
import { tsIdentifier, tsPropertyDeclaration } from "./typescript-names.js";

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

    const mapper = type.templateMapper;
    if (mapper) {
      for (const arg of mapper.args) {
        if (isType(arg)) {
          addModelName(ctx, arg, names, seen);
        }
      }
    }

    if (BUILTIN_TYPE_NAMES.has(type.name)) return;
    names.add(tsIdentifier(type.name, "Model"));

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
    parts.push(tsPropertyDeclaration(param.param.name, typeToTs(ctx, param.param.type), {
      optional: param.param.optional,
    }));
  }

  if (op.parameters.body) {
    const body = op.parameters.body;

    // Multipart body — build type from parts
    if ("bodyKind" in body && body.bodyKind === "multipart" && "parts" in body) {
      const multiParts = (body as any).parts as ReadonlyArray<{ name?: string; body: { type: Type }; optional: boolean; multi: boolean }>;
      for (const part of multiParts) {
        if (!part.name) continue;
        let tsType = typeToTs(ctx, part.body.type);
        if (part.multi) tsType = `${tsType}[]`;
        parts.push(tsPropertyDeclaration(part.name, tsType, { optional: part.optional }));
      }
    } else {
      const bodyType = body.type;
      if (parts.length === 0 && bodyType.kind === "Model" && bodyType.name) {
        return typeToTs(ctx, bodyType);
      }

      if (bodyType.kind === "Model") {
        for (const [, prop] of bodyType.properties) {
          parts.push(tsPropertyDeclaration(prop.name, typeToTs(ctx, prop.type), {
            optional: prop.optional,
          }));
        }
      }
    }
  }

  if (parts.length === 0) return "Record<string, never>";
  return `{ ${parts.join("; ")} }`;
}

export function buildResultType(ctx: EmitterCtx, op: HttpOperation): string {
  const types: string[] = [];
  const seen = new Set<string>();

  for (const resp of op.responses) {
    const tsType = resp.type.kind === "Intrinsic" && resp.type.name === "void"
      ? "void"
      : responseTypeToTs(ctx, resp);
    if (!seen.has(tsType)) {
      types.push(tsType);
      seen.add(tsType);
    }
  }

  if (types.length === 0) return "void";
  return types.join(" | ");
}

function responseTypeToTs(ctx: EmitterCtx, resp: HttpOperationResponse): string {
  if (resp.type.kind !== "Model" || !hasResponseEnvelopeMetadata(resp)) {
    return typeToTs(ctx, resp.type);
  }

  if (resp.type.name && !hasHandlerVisibleMetadata(resp)) {
    return typeToTs(ctx, resp.type);
  }

  const hiddenProperties = getHiddenResponsePropertyNames(resp);
  const parts: string[] = [];
  for (const prop of resp.type.properties.values()) {
    if (hiddenProperties.has(prop.name)) continue;
    parts.push(tsPropertyDeclaration(prop.name, typeToTs(ctx, prop.type), {
      optional: prop.optional,
    }));
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

function hasHandlerVisibleMetadata(resp: HttpOperationResponse): boolean {
  return resp.responses.some((content) =>
    content.properties.some((prop) =>
      prop.kind === "header" ||
      prop.kind === "body"
    )
  );
}

function getHiddenResponsePropertyNames(resp: HttpOperationResponse): Set<string> {
  const hidden = new Set<string>();
  for (const content of resp.responses) {
    for (const prop of content.properties) {
      if (prop.kind === "statusCode" || prop.kind === "contentType") {
        hidden.add(prop.property.name);
      }
    }
  }
  return hidden;
}

export function toColonPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

/** Response encoder expression used in generated result encoder objects. */
export function emitResultResponseEncoder(
  ctx: EmitterCtx,
  op: HttpOperation,
  resultType: string,
): string {
  const responses = collectResponseVariants(ctx, op);
  if (responses.length > 1) {
    const branches = buildResponseBranches(ctx, op, responses);
    if (branches.length > 0) {
      return emitResponseDecisionEncoder(resultType, branches);
    }
    $lib.reportDiagnostic(ctx.program, {
      code: "undifferentiable-response-union",
      target: op.operation,
    });
  }

  const response = responses[0];
  if (!response) {
    return "ResponseEncoders.empty(204)";
  }
  if (response.isVoid) {
    return `ResponseEncoders.empty(${response.statusCode})`;
  }

  if (shouldUseVariantEncoder(response)) {
    return `ResponseEncoders.variant<${resultType}>(${emitResponseVariant(response)})`;
  }

  const headers = response.headers;
  const encoder = pickEncoderForContentType(response.contentType, resultType, response.statusCode);

  if (headers.length > 0 && encoder.startsWith("ResponseEncoders.json")) {
    const entries = headers
      .map((h) => `[${JSON.stringify(h.property)}, ${JSON.stringify(h.header)}]`)
      .join(", ");
    return `ResponseEncoders.jsonWithHeaders<${resultType}>(${response.statusCode}, [${entries}])`;
  }

  return encoder;
}

function shouldUseVariantEncoder(response: SuccessResponseVariant): boolean {
  return response.bodyProperty !== undefined ||
    response.omitProperties.length > 0;
}

interface SuccessResponseVariant {
  readonly statusCode: number;
  readonly isVoid: boolean;
  readonly contentType: string | undefined;
  readonly headers: ResponseHeader[];
  readonly bodyProperty?: string;
  readonly omitProperties: readonly string[];
  readonly type: Type;
  readonly model?: Model;
  readonly tsType: string;
  readonly hiddenProperties: ReadonlySet<string>;
}

function collectResponseVariants(
  ctx: EmitterCtx,
  op: HttpOperation,
): SuccessResponseVariant[] {
  const variants: SuccessResponseVariant[] = [];

  for (const resp of op.responses) {
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
    const hiddenProperties = getHiddenResponsePropertyNames(resp);
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
      type: resp.type,
      model: resp.type.kind === "Model" ? resp.type : undefined,
      tsType: resp.type.kind === "Intrinsic" && resp.type.name === "void"
        ? "void"
        : responseTypeToTs(ctx, resp),
      hiddenProperties,
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

interface ResponseBranch {
  readonly response: SuccessResponseVariant;
  readonly condition: string;
}

function buildResponseBranches(
  ctx: EmitterCtx,
  op: HttpOperation,
  responses: readonly SuccessResponseVariant[],
): ResponseBranch[] {
  const branches: ResponseBranch[] = [];
  const pending = new Set(responses);

  const voidResponses = responses.filter((response) => response.isVoid);
  if (voidResponses.length > 1) return [];
  if (voidResponses.length === 1) {
    const [response] = voidResponses;
    branches.push({ response, condition: "result === undefined" });
    pending.delete(response);
  }

  for (const response of [...pending]) {
    const condition = emitDirectTypeCondition(ctx, response);
    if (!condition) continue;
    branches.push({ response, condition });
    pending.delete(response);
  }

  if (pending.size === 0) return branches;

  const objectResponses = [...pending].filter((response) =>
    response.model && !isArrayModelType(ctx.program, response.model)
  );
  if (objectResponses.length !== pending.size) return [];

  if (objectResponses.length === 1) {
    branches.push({
      response: objectResponses[0],
      condition: `typeof result === "object" && result !== null && !Array.isArray(result)`,
    });
    return branches;
  }

  const explicitDiscriminator = resolveExplicitDiscriminatorBranches(ctx, op, objectResponses);
  if (explicitDiscriminator) {
    branches.push(...explicitDiscriminator);
    return branches;
  }

  const literalDiscriminator = resolveImplicitLiteralBranches(ctx, objectResponses);
  if (literalDiscriminator) {
    branches.push(...literalDiscriminator);
    return branches;
  }

  const propertyMatcher = resolvePropertyBranches(ctx, objectResponses);
  if (propertyMatcher) {
    branches.push(...propertyMatcher);
    return branches;
  }

  return [];
}

function emitDirectTypeCondition(
  ctx: EmitterCtx,
  response: SuccessResponseVariant,
): string | undefined {
  if (response.model && isArrayModelType(ctx.program, response.model)) {
    return "Array.isArray(result)";
  }

  if (response.type.kind === "Intrinsic" && response.type.name === "null") {
    return "result === null";
  }

  if (response.type.kind !== "Scalar") return undefined;

  const scalarName = response.type.name;
  if (scalarName === "string") {
    return `typeof result === "string"`;
  }
  if (scalarName === "boolean") {
    return `typeof result === "boolean"`;
  }
  if (scalarName === "bytes") {
    return "result instanceof Uint8Array";
  }
  if (
    scalarName === "int32" ||
    scalarName === "int64" ||
    scalarName === "float32" ||
    scalarName === "float64" ||
    scalarName === "numeric" ||
    scalarName === "integer" ||
    scalarName === "float" ||
    scalarName === "decimal"
  ) {
    return `typeof result === "number"`;
  }

  return undefined;
}

function resolveExplicitDiscriminatorBranches(
  ctx: EmitterCtx,
  op: HttpOperation,
  responses: readonly SuccessResponseVariant[],
): ResponseBranch[] | undefined {
  const returnType = op.operation.returnType;
  const discriminator = returnType.kind === "Union"
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
  responses: readonly SuccessResponseVariant[],
): ResponseBranch[] | undefined {
  const candidateFields = new Set<string>();
  for (const response of responses) {
    for (const prop of getResponseProperties(response)) {
      if (isResponseDispatchMetadata(ctx, response, prop.name)) continue;
      if (prop.type.kind === "String" || prop.type.kind === "Number") {
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
  responses: readonly SuccessResponseVariant[],
): ResponseBranch[] | undefined {
  if (!field) return undefined;

  const branches: ResponseBranch[] = [];
  const values = new Set<string>();

  for (const response of responses) {
    const prop = getResponseProperty(response, field);
    if (!prop || prop.optional || isResponseDispatchMetadata(ctx, response, prop.name)) {
      return undefined;
    }
    if (prop.type.kind !== "String" && prop.type.kind !== "Number") return undefined;
    const value = String(prop.type.value);
    if (values.has(value)) return undefined;
    values.add(value);
    branches.push({
      response,
      condition: `typeof result === "object" && result !== null && ${JSON.stringify(field)} in result && result[${JSON.stringify(field)}] === ${JSON.stringify(prop.type.value)}`,
    });
  }

  return branches;
}

function resolvePropertyBranches(
  ctx: EmitterCtx,
  responses: readonly SuccessResponseVariant[],
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
      const isUnique = modelProps.every((otherProps, j) => j === i || !otherProps.has(prop));
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
    const excludedProps = uniqueProperties.filter((_, j) => j !== i);
    branches.push({
      response: responses[i],
      condition: emitExclusivePropertyCondition(uniqueProp, excludedProps),
    });
  }

  return branches;
}

function emitExclusivePropertyCondition(
  requiredProperty: string,
  excludedProperties: readonly string[],
): string {
  const checks = [
    `typeof result === "object"`,
    `result !== null`,
    `${JSON.stringify(requiredProperty)} in result`,
    ...excludedProperties.map((prop) => `!(${JSON.stringify(prop)} in result)`),
  ];
  return checks.join(" && ");
}

function isResponseDispatchMetadata(
  ctx: EmitterCtx,
  response: SuccessResponseVariant,
  propertyName: string,
): boolean {
  if (response.hiddenProperties.has(propertyName)) return true;
  const prop = getResponseProperty(response, propertyName);
  return prop !== undefined && isHeader(ctx.program, prop);
}

function findCommonModelDiscriminator(
  ctx: EmitterCtx,
  responses: readonly SuccessResponseVariant[],
): string | undefined {
  const fields = responses.map((response) => findModelDiscriminator(ctx, response.model));
  const [first] = fields;
  if (!first) return undefined;
  return fields.every((field) => field === first) ? first : undefined;
}

function findModelDiscriminator(
  ctx: EmitterCtx,
  model: Model | undefined,
): string | undefined {
  let current = model;
  while (current) {
    const discriminator = getDiscriminator(ctx.program, current);
    if (discriminator) return discriminator.propertyName;
    current = current.baseModel;
  }
  return undefined;
}

function getResponseProperties(response: SuccessResponseVariant): ModelProperty[] {
  return response.model ? [...walkPropertiesInherited(response.model)] : [];
}

function getResponseProperty(
  response: SuccessResponseVariant,
  propertyName: string,
): ModelProperty | undefined {
  return getResponseProperties(response).find((prop) => prop.name === propertyName);
}

function emitResponseDecisionEncoder(
  resultType: string,
  branches: readonly ResponseBranch[],
): string {
  const lines: string[] = [];
  lines.push(`ResponseEncoders.matchVariant<${resultType}>([`);
  branches.forEach((branch) => {
    lines.push("{");
    lines.push(`when: (result): result is ${branch.response.tsType} => ${branch.condition},`);
    lines.push(`encoder: ResponseEncoders.variant<${branch.response.tsType}>(${emitResponseVariant(branch.response)}),`);
    lines.push("},");
  });
  // TODO: Benchmark matchVariant against generated direct if/switch dispatch for hot response paths.
  lines.push("])");
  return lines.join("\n");
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

/** Resolves status code from a @statusCode property on the model. */
function resolveStatusCodeFromModel(ctx: EmitterCtx, model: Model): number | undefined {
  for (const [, prop] of model.properties) {
    if (isStatusCode(ctx.program, prop) && prop.type.kind === "Number") {
      return prop.type.value;
    }
  }
  return undefined;
}
