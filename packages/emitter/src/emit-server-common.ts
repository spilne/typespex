import type { Model, ModelProperty, Type } from "@typespec/compiler";
import {
  getDiscriminator,
  isArrayModelType,
  isErrorModel,
  isRecordModelType,
  isType,
  walkPropertiesInherited,
} from "@typespec/compiler";
import type { HttpOperation, HttpOperationResponse } from "@typespec/http";
import { getHeaderFieldName, isHeader, isMetadata, isStatusCode } from "@typespec/http";
import type { EmitterCtx } from "./ctx.js";
import { $lib } from "./lib.js";
import { scalarToTs } from "./scalar-map.js";
import { isEntityLike } from "./type-guards.js";
import {
  isTemplatedScalarReference,
  isTemplatedUnionReference,
  isTypeSpecNamespaceModel,
  typeToTs,
} from "./type-reference.js";
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

  addModelName(ctx, op.operation.returnType, names, new Set());

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

    if (isTypeSpecNamespaceModel(type)) {
      for (const prop of walkPropertiesInherited(type)) {
        addModelName(ctx, prop.type, names, seen);
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

    for (const prop of walkPropertiesInherited(type)) {
      addModelName(ctx, prop.type, names, seen);
    }
  }

  if (type.kind === "Union") {
    addTemplatedUnionName(ctx, type, names, seen);
    for (const v of type.variants.values()) {
      addModelName(ctx, v.type, names, seen);
    }
  }

  if (type.kind === "Scalar") {
    addTemplatedScalarName(ctx, type, names, seen);
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

function addTemplatedUnionName(
  ctx: EmitterCtx,
  type: Extract<Type, { kind: "Union" }>,
  names: Set<string>,
  seen: Set<Type>,
): void {
  if (!type.name || !isTemplatedUnionReference(type)) return;
  names.add(tsIdentifier(type.name, "Union"));
  addTemplateArgumentModelNames(ctx, type.templateMapper?.args ?? [], names, seen);
}

function addTemplatedScalarName(
  ctx: EmitterCtx,
  type: Extract<Type, { kind: "Scalar" }>,
  names: Set<string>,
  seen: Set<Type>,
): void {
  if (!isTemplatedScalarReference(type)) return;
  names.add(tsIdentifier(type.name, "Scalar"));
  addTemplateArgumentModelNames(ctx, type.templateMapper?.args ?? [], names, seen);
}

function addTemplateArgumentModelNames(
  ctx: EmitterCtx,
  args: readonly unknown[],
  names: Set<string>,
  seen: Set<Type>,
): void {
  for (const arg of args) {
    if (isEntityLike(arg) && isType(arg)) {
      addModelName(ctx, arg, names, seen);
    }
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
      if (parts.length === 0) {
        return typeToTs(ctx, bodyType);
      }

      if (shouldFlattenBodyType(ctx, bodyType)) {
        for (const prop of walkPropertiesInherited(bodyType)) {
          if (isMetadata(ctx.program, prop)) continue;
          parts.push(tsPropertyDeclaration(prop.name, typeToTs(ctx, prop.type), {
            optional: prop.optional,
          }));
        }
      } else {
        parts.push(tsPropertyDeclaration("body", typeToTs(ctx, bodyType)));
      }
    }
  }

  if (parts.length === 0) return "Record<string, never>";
  return `{ ${parts.join("; ")} }`;
}

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
        ? responseContentToTs(ctx, resp, content)
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

export function shouldFlattenBodyType(ctx: EmitterCtx, type: Type): type is Model {
  return type.kind === "Model" &&
    !isArrayModelType(ctx.program, type) &&
    !isRecordModelType(ctx.program, type);
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
      return emitResponseDecisionEncoder(ctx, op, resultType, branches);
    }
    $lib.reportDiagnostic(ctx.program, {
      code: "undifferentiable-response-union",
      target: op.operation,
    });
    // Don't silently fall back to responses[0] — that would ship a server
    // that handles only the first declared variant. Emit a placeholder that
    // throws if anyone bypasses the diagnostic, matching the unsupported-CT
    // pattern from PR #26.
    return emitUnsupportedEncoderReason(
      resultType,
      `Operation "${op.operation.name}" declares ${responses.length} response variants the emitter cannot ` +
        `distinguish at the result-value level. @typespex/emitter cannot serialize this; regenerate after ` +
        `addressing the diagnostic.`,
    );
  }

  const response = responses[0];
  if (!response) {
    return "ResponseEncoders.empty(204)";
  }
  if (response.isVoid) {
    return `ResponseEncoders.empty(${response.statusCode})`;
  }

  const kind = classifyResponseContentType(ctx, op, response.contentType);
  if (kind === "unsupported") {
    return emitUnsupportedEncoder(resultType, op.operation.name, response.contentType);
  }

  if (shouldUseVariantEncoder(response)) {
    return `ResponseEncoders.variant<${resultType}>(${emitResponseVariant(kind, response)})`;
  }

  const headers = response.headers;
  const encoder = encoderForKind(kind, resultType, response.statusCode);

  if (headers.length > 0 && kind === "json") {
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
    const statusCode = resolveResponseStatusCode(ctx, resp);
    const isVoid = resp.type.kind === "Intrinsic" && resp.type.name === "void";
    const hiddenProperties = getHiddenResponsePropertyNames(resp);

    if (isVoid || resp.responses.length === 0) {
      variants.push({
        statusCode: isVoid && statusCode === 200 ? 204 : statusCode,
        isVoid,
        contentType: undefined,
        headers: [],
        omitProperties: [],
        type: resp.type,
        model: resp.type.kind === "Model" ? resp.type : undefined,
        tsType: isVoid ? "void" : responseTypeToTs(ctx, resp),
        hiddenProperties,
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
      const declaredContentTypes = body?.contentTypes.length ? body.contentTypes : [undefined];
      const headers = collectResponseHeadersFromContent(ctx, content);
      const metadataProperties = content.properties.filter((prop) =>
        prop.kind === "header" ||
        prop.kind === "statusCode" ||
        prop.kind === "contentType" ||
        prop.kind === "body"
      );
      // Per-content variant gets the body's own model when available, so the
      // property-based dispatcher can find fields unique to this variant.
      // Same-status, same-CT shapes with different bodies need this to avoid
      // collapsing to a single shared model.
      const variantModel = body?.type.kind === "Model" ? body.type : undefined;

      for (const contentType of declaredContentTypes) {
        variants.push({
          statusCode,
          isVoid: false,
          contentType,
          headers,
          bodyProperty: body?.property?.name,
          omitProperties: metadataProperties.map((prop) => prop.property.name),
          type: body?.type ?? resp.type,
          model: variantModel,
          tsType: responseContentToTs(ctx, resp, content),
          hiddenProperties,
        });
      }
    }
  }

  return variants;
}

/**
 * Handler-facing TypeScript type for a single content variant of a response.
 * For a single-content response with no envelope metadata, this is just the
 * underlying body type. Otherwise it's an envelope `{ body: T; ...headers }`
 * synthesized from this content's body and the response model's headers, with
 * statusCode/contentType always stripped (the runtime sets them).
 */
function responseContentToTs(
  ctx: EmitterCtx,
  resp: HttpOperationResponse,
  content: HttpOperationResponse["responses"][number],
): string {
  if (resp.type.kind !== "Model" || !hasResponseEnvelopeMetadata(resp)) {
    return typeToTs(ctx, resp.type);
  }

  // Named model with no handler-visible metadata AND only one content entry
  // can keep referring to the model by name. Multi-content responses always
  // synthesize per-content envelopes because the bodies differ.
  if (resp.type.name && !hasHandlerVisibleMetadata(resp) && resp.responses.length === 1) {
    return typeToTs(ctx, resp.type);
  }

  const parts: string[] = [];
  for (const prop of content.properties) {
    if (prop.kind === "statusCode" || prop.kind === "contentType") continue;
    const tsType = prop.kind === "body" && content.body
      ? typeToTs(ctx, content.body.type)
      : typeToTs(ctx, prop.property.type);
    parts.push(tsPropertyDeclaration(prop.property.name, tsType, {
      optional: prop.property.optional,
    }));
  }
  return parts.length === 0 ? "Record<string, never>" : `{ ${parts.join("; ")} }`;
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
    const [single] = objectResponses;
    branches.push({
      response: single,
      condition: emitObjectShapeCondition(single),
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
  const subject = subjectExpr(response);
  if (response.model && isArrayModelType(ctx.program, response.model)) {
    return wrapSubjectGuard(response, `Array.isArray(${subject})`);
  }

  if (response.type.kind === "Intrinsic" && response.type.name === "null") {
    return wrapSubjectGuard(response, `${subject} === null`);
  }

  if (response.type.kind !== "Scalar") return undefined;

  const scalarType = scalarToTs(response.type);
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

  return undefined;
}

/**
 * Expression for the value a dispatcher should test against `result`. For
 * envelope variants (where `@body body: T` wraps the handler-facing shape),
 * predicates must target `result[bodyProperty]` rather than the envelope
 * itself; otherwise property/type checks generated from the body's model
 * would always miss against the envelope object.
 */
function subjectExpr(variant: SuccessResponseVariant): string {
  if (variant.bodyProperty === undefined) return "result";
  return `(result as Record<string, unknown>)[${JSON.stringify(variant.bodyProperty)}]`;
}

/**
 * For envelope variants, predicates that inspect the body must also assert
 * the envelope exists. Direct-result variants don't need the extra guard.
 */
function wrapSubjectGuard(variant: SuccessResponseVariant, condition: string): string {
  if (variant.bodyProperty === undefined) return condition;
  return `typeof result === "object" && result !== null && ${JSON.stringify(variant.bodyProperty)} in result && ${condition}`;
}

/** Common shape check that the variant's subject is a plain object. */
function emitObjectShapeCondition(variant: SuccessResponseVariant): string {
  const subject = subjectExpr(variant);
  const base = `typeof ${subject} === "object" && ${subject} !== null && !Array.isArray(${subject})`;
  return wrapSubjectGuard(variant, base);
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
    const subject = subjectExpr(response);
    const cast = response.bodyProperty === undefined ? subject : `(${subject} as Record<string, unknown>)`;
    const base = `${JSON.stringify(field)} in ${cast} && ${cast}[${JSON.stringify(field)}] === ${JSON.stringify(prop.type.value)}`;
    const guarded = response.bodyProperty === undefined
      ? `typeof ${subject} === "object" && ${subject} !== null && ${base}`
      : `${emitObjectShapeCondition(response)} && ${base}`;
    branches.push({ response, condition: guarded });
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
      condition: emitExclusivePropertyCondition(responses[i], uniqueProp, excludedProps),
    });
  }

  return branches;
}

function emitExclusivePropertyCondition(
  response: SuccessResponseVariant,
  requiredProperty: string,
  excludedProperties: readonly string[],
): string {
  const subject = subjectExpr(response);
  const cast = response.bodyProperty === undefined ? subject : `(${subject} as Record<string, unknown>)`;
  const propertyChecks = [
    `${JSON.stringify(requiredProperty)} in ${cast}`,
    ...excludedProperties.map((prop) => `!(${JSON.stringify(prop)} in ${cast})`),
  ];
  if (response.bodyProperty === undefined) {
    return [
      `typeof ${subject} === "object"`,
      `${subject} !== null`,
      ...propertyChecks,
    ].join(" && ");
  }
  return [emitObjectShapeCondition(response), ...propertyChecks].join(" && ");
}

type BodyShape = "array" | "string" | "number" | "boolean" | "bytes" | "object";

/**
 * Dispatch variants whose envelope is a single `body` property and whose
 * body runtime shapes (array vs string vs number vs bytes vs object) are
 * all distinct. Generates `Array.isArray(result.body)` /
 * `typeof result.body === "..."` checks. Returns undefined when fewer than
 * two variants qualify or when two variants share the same body shape.
 */
function resolveEnvelopeBodyShapeBranches(
  ctx: EmitterCtx,
  responses: readonly SuccessResponseVariant[],
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
    const tsType = scalarToTs(type);
    if (tsType === "string") return "string";
    if (tsType === "number") return "number";
    if (tsType === "boolean") return "boolean";
    if (tsType === "Uint8Array") return "bytes";
    return undefined;
  }
  return undefined;
}

function emitBodyShapeCondition(bodyProperty: string, shape: BodyShape): string {
  const body = `(result as Record<string, unknown>)[${JSON.stringify(bodyProperty)}]`;
  const guard = `typeof result === "object" && result !== null && ${JSON.stringify(bodyProperty)} in result`;
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
  }
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
  ctx: EmitterCtx,
  op: HttpOperation,
  resultType: string,
  branches: readonly ResponseBranch[],
): string {
  const lines: string[] = [];
  lines.push(`ResponseEncoders.matchVariant<${resultType}>([`);
  branches.forEach((branch) => {
    const kind = branch.response.isVoid
      ? "empty"
      : classifyResponseContentType(ctx, op, branch.response.contentType);
    const branchEncoder = kind === "unsupported"
      ? emitUnsupportedEncoder(branch.response.tsType, op.operation.name, branch.response.contentType)
      : `ResponseEncoders.variant<${branch.response.tsType}>(${emitResponseVariant(kind, branch.response)})`;
    lines.push("{");
    lines.push(`when: (result): result is ${branch.response.tsType} => ${branch.condition},`);
    lines.push(`encoder: ${branchEncoder},`);
    lines.push("},");
  });
  // TODO: Benchmark matchVariant against generated direct if/switch dispatch for hot response paths.
  lines.push("])");
  return lines.join("\n");
}

function emitResponseVariant(
  kind: Exclude<ResponseEncoderKind, "unsupported">,
  response: SuccessResponseVariant,
): string {
  const fields = [`status: ${response.statusCode}`];
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

type ResponseEncoderKind = "json" | "text" | "bytes" | "empty" | "unsupported";

/**
 * Maps an HTTP response content type to the matching `ResponseEncoders` kind.
 * Unrecognized types (e.g. `application/xml`, `multipart/*`) report a hard
 * diagnostic and return `"unsupported"`; callers emit a placeholder encoder
 * that throws at runtime so we never silently coerce a non-conforming
 * response to JSON. Missing content types default to JSON without warning
 * — TypeSpec doesn't require operations to declare one.
 */
function classifyResponseContentType(
  ctx: EmitterCtx,
  op: HttpOperation,
  contentType: string | undefined,
): ResponseEncoderKind {
  if (!contentType) return "json";
  if (contentType.includes("json")) return "json";
  if (contentType === "text/plain" || contentType.startsWith("text/")) return "text";
  if (contentType === "application/octet-stream") return "bytes";

  $lib.reportDiagnostic(ctx.program, {
    code: "unsupported-response-content-type",
    format: { contentType, operationName: op.operation.name },
    target: op.operation,
  });
  return "unsupported";
}

function encoderForKind(
  kind: Exclude<ResponseEncoderKind, "unsupported">,
  tsType: string,
  status: number,
): string {
  switch (kind) {
    case "empty":
      return `ResponseEncoders.empty(${status})`;
    case "text":
      return `ResponseEncoders.text(${status})`;
    case "bytes":
      return `ResponseEncoders.bytes(${status})`;
    case "json":
      return `ResponseEncoders.json<${tsType}>(${status})`;
  }
}

function emitUnsupportedEncoder(
  resultType: string,
  operationName: string,
  contentType: string | undefined,
): string {
  return emitUnsupportedEncoderReason(
    resultType,
    `Operation "${operationName}" declares unsupported response content type "${contentType ?? ""}". ` +
      `@typespex/emitter cannot serialize this; regenerate after addressing the diagnostic.`,
  );
}

function emitUnsupportedEncoderReason(resultType: string, reason: string): string {
  return `ResponseEncoders.unsupported<${resultType}>(${JSON.stringify(reason)})`;
}

interface ResponseHeader {
  readonly property: string;
  readonly header: string;
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
  return isErrorModel(ctx.program, resp.type) ? 500 : 200;
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
