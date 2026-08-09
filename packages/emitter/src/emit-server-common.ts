import type { Interface, Model, ModelProperty, Type } from "@typespec/compiler";
import {
  getDiscriminator,
  isArrayModelType,
  isErrorModel,
  isRecordModelType,
  isType,
  walkPropertiesInherited,
} from "@typespec/compiler";
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
  isHeader,
  isStatusCode,
} from "@typespec/http";
import { isJsonMediaType, isTextMediaType, normalizeMediaType } from "./body-media-kinds.js";
import {
  allocateGeneratedNames,
  getGeneratedTypeName,
  getNamespaceFullName,
  getRelativeNamespaceSegments,
  hasGeneratedTypeNameCollision,
  type EmitterCtx,
} from "./ctx.js";
import { getHttpPartType, isHttpFileModel, propertiesShareSource } from "./http-models.js";
import {
  emitJsonWireSerializer,
  unsupportedJsonWireTransformReason,
} from "./json-wire-transforms.js";
import { $lib } from "./lib.js";
import {
  getAdditionalPropertiesValue,
  isNeverAdditionalProperties,
  isPureRecordModel,
} from "./model-indexer.js";
import { multipartBodyTypeToTs, multipartModelPropertyDeclarations } from "./multipart-input.js";
import {
  getPayloadCollection,
  getPayloadBodyContext,
  getRequestBodyProjection,
  getResponseBodyProjection,
  payloadModelProperties,
  payloadProjectionChangesType,
  payloadPropertyOptional,
  payloadTypeToTs,
  type PayloadProjection,
} from "./payload-context.js";
import { scalarToTs } from "./scalar-map.js";
import { resolveScalarEncoding } from "./scalar-encoding.js";
import { getRequestInputPlan, shouldFlattenBodyType } from "./request-input-plan.js";
import { isEntityLike } from "./type-guards.js";
import {
  isNamedUnionReference,
  isTemplatedScalarReference,
  isTemplatedUnionReference,
  isTypeSpecNamespaceModel,
  typeToTs,
} from "./type-reference.js";
import { tsIdentifier, tsPropertyAccess, tsPropertyDeclaration } from "./typescript-names.js";
import { isBytesScalar, isTextResponseType, unsupportedFileContentsReason } from "./wire-types.js";

export interface OperationGroup {
  interfaceName?: string;
  propertyName: string;
  exportName: string;
  operations: HttpOperation[];
}

export function collectModelImports(ctx: EmitterCtx, operations: HttpOperation[]): string[] {
  const names = new Set<string>();
  for (const op of operations) {
    collectTypeNames(ctx, op, names);
  }
  return [...names].filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)).sort();
}

function collectTypeNames(ctx: EmitterCtx, op: HttpOperation, names: Set<string>): void {
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

function addModelName(ctx: EmitterCtx, type: Type, names: Set<string>, seen: Set<Type>): void {
  if (seen.has(type)) return;
  seen.add(type);

  if (type.kind === "Model") {
    if (isArrayModelType(ctx.program, type)) {
      if (type.indexer) {
        addModelName(ctx, type.indexer.value, names, seen);
      }
      return;
    }
    if (isPureRecordModel(type)) {
      const additionalType = getAdditionalPropertiesValue(type);
      if (additionalType) addModelName(ctx, additionalType, names, seen);
      return;
    }

    const httpPartType = getHttpPartType(ctx.program, type);
    if (httpPartType) {
      addModelName(ctx, httpPartType, names, seen);
      return;
    }
    if (isHttpFileModel(ctx.program, type)) return;

    if (!type.name || isTypeSpecNamespaceModel(type)) {
      for (const prop of walkPropertiesInherited(type)) {
        addModelName(ctx, prop.type, names, seen);
      }
      const additionalType = getAdditionalPropertiesValue(type);
      if (additionalType) addModelName(ctx, additionalType, names, seen);
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

    names.add(getGeneratedTypeName(ctx, type, "Model"));

    for (const prop of walkPropertiesInherited(type)) {
      addModelName(ctx, prop.type, names, seen);
    }
    const additionalType = getAdditionalPropertiesValue(type);
    if (additionalType) addModelName(ctx, additionalType, names, seen);
  }

  if (type.kind === "Union") {
    addReferencedUnionName(ctx, type, names, seen);
    for (const v of type.variants.values()) {
      addModelName(ctx, v.type, names, seen);
    }
  }

  if (type.kind === "Scalar") {
    addReferencedScalarName(ctx, type, names, seen);
  }

  if (type.kind === "Enum" && hasGeneratedTypeNameCollision(ctx, type)) {
    names.add(getGeneratedTypeName(ctx, type, "Enum"));
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

function addReferencedUnionName(
  ctx: EmitterCtx,
  type: Extract<Type, { kind: "Union" }>,
  names: Set<string>,
  seen: Set<Type>,
): void {
  if (!isNamedUnionReference(type) && !hasGeneratedTypeNameCollision(ctx, type)) return;
  names.add(getGeneratedTypeName(ctx, type, "Union"));
  addTemplateArgumentModelNames(ctx, type.templateMapper?.args ?? [], names, seen);
}

function addReferencedScalarName(
  ctx: EmitterCtx,
  type: Extract<Type, { kind: "Scalar" }>,
  names: Set<string>,
  seen: Set<Type>,
): void {
  if (!isTemplatedScalarReference(type) && !hasGeneratedTypeNameCollision(ctx, type)) return;
  names.add(getGeneratedTypeName(ctx, type, "Scalar"));
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

export function groupOperations(ctx: EmitterCtx, operations: HttpOperation[]): OperationGroup[] {
  const standalone: HttpOperation[] = [];
  const grouped = new Map<Interface, HttpOperation[]>();

  for (const op of operations) {
    const iface = op.operation.interface;
    if (!iface) {
      standalone.push(op);
      continue;
    }

    const interfaceOperations = grouped.get(iface) ?? [];
    interfaceOperations.push(op);
    grouped.set(iface, interfaceOperations);
  }

  const interfaceCandidates = [...grouped.keys()].map((iface) => {
    const relativeNamespace = getRelativeNamespaceSegments(ctx.service.namespace, iface.namespace);
    const qualifiedSegments =
      relativeNamespace.length > 0 ? [...relativeNamespace, iface.name] : [iface.name, "Interface"];
    return {
      value: iface,
      stableKey: `${getNamespaceFullName(iface.namespace)}.${iface.name}`,
      baseName: iface.name,
      qualifiedName: qualifiedSegments.join("_"),
      fallbackName: [ctx.serviceName, ...qualifiedSegments, "Interface"].join("_"),
    };
  });
  const standaloneExportName = tsIdentifier(ctx.serviceName, "Group");
  const interfaceExportNames = allocateGeneratedNames(
    interfaceCandidates,
    new Set([
      tsIdentifier(ctx.serviceName, "Service"),
      ...(standalone.length > 0 ? [standaloneExportName] : []),
    ]),
  );
  const interfacePropertyNames = allocateGeneratedNames(
    interfaceCandidates.map((candidate) => ({ ...candidate, preserveBaseName: true })),
  );

  const ordered: OperationGroup[] = [...grouped.entries()].map(([iface, interfaceOperations]) => ({
    interfaceName: iface.name,
    propertyName: interfacePropertyNames.get(iface)!,
    exportName: interfaceExportNames.get(iface)!,
    operations: interfaceOperations,
  }));
  if (standalone.length > 0) {
    ordered.push({
      propertyName: "__standalone__",
      exportName: standaloneExportName,
      operations: standalone,
    });
  }

  return ordered;
}

export function buildInputType(ctx: EmitterCtx, op: HttpOperation): string {
  const parts: string[] = [];
  const inputPlan = getRequestInputPlan(ctx, op);

  for (const param of op.parameters.parameters) {
    parts.push(
      tsPropertyDeclaration(param.param.name, typeToTs(ctx, param.param.type), {
        optional: param.param.optional,
      }),
    );
  }

  if (op.parameters.body) {
    const body = op.parameters.body;
    const hasNonBodyInput = parts.length > 0;

    // Multipart body — build type from parts
    if ("bodyKind" in body && body.bodyKind === "multipart" && "parts" in body) {
      const bodyOptional = body.property?.optional === true;
      if (inputPlan.body?.placement === "wrapped") {
        const multipartType = multipartBodyTypeToTs(ctx, body);
        parts.push(
          tsPropertyDeclaration(inputPlan.body.propertyName, multipartType, {
            optional: bodyOptional,
          }),
        );
        return `{ ${parts.join("; ")} }`;
      }
      if (bodyOptional && !hasNonBodyInput) {
        const multipartType = multipartBodyTypeToTs(ctx, body);
        return `${multipartType} | undefined`;
      }
      if (body.multipartKind === "tuple") {
        return multipartBodyTypeToTs(ctx, body);
      }
      parts.push(...multipartModelPropertyDeclarations(ctx, body, bodyOptional && hasNonBodyInput));
    } else {
      const bodyType = body.type;
      const bodyOptional = body.property?.optional === true;
      const projection = getRequestBodyProjection(ctx, op);
      // Materialize the complete projected reference even when the public
      // handler shape is flattened. Recursive decoder declarations may need
      // the projection-specific alias registered by this call.
      const bodyTypeTs = payloadTypeToTs(ctx, bodyType, projection);
      if (parts.length === 0) {
        return bodyOptional ? `${bodyTypeTs} | undefined` : bodyTypeTs;
      }

      if (inputPlan.body?.placement === "flattened" && shouldFlattenBodyType(ctx, bodyType)) {
        for (const prop of payloadModelProperties(bodyType, projection)) {
          parts.push(
            tsPropertyDeclaration(prop.name, payloadTypeToTs(ctx, prop.type, projection), {
              optional: bodyOptional || payloadPropertyOptional(prop, projection),
            }),
          );
        }
      } else {
        parts.push(
          tsPropertyDeclaration(
            inputPlan.body?.placement === "wrapped" ? inputPlan.body.propertyName : "body",
            bodyTypeTs,
            {
              optional: bodyOptional,
            },
          ),
        );
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
  const [response] = op.responses;
  if (response.responses.length !== 1 || hasResponseEnvelopeMetadata(response)) {
    return undefined;
  }

  const [content] = response.responses;
  const body = content?.body;
  if (
    !body ||
    payloadProjectionChangesType(ctx, body.type, getResponseBodyProjection(ctx, content))
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
          reportUnsupportedStatus(
            ctx,
            op,
            'wildcard status "*" has no @statusCode property that can provide the actual response status',
          );
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

  const kind = classifyResponseVariant(ctx, op, response);
  if (kind === "unsupported") {
    return emitUnsupportedEncoder(resultType, op.operation.name, response.contentType);
  }
  const bodyTransform = getResponseBodyTransform(ctx, op, response, kind);

  if (shouldUseVariantEncoder(response)) {
    return `ResponseEncoders.variant<${resultType}>(${emitResponseVariant(kind, response, bodyTransform)})`;
  }

  const headers = response.headers;
  const encoder = encoderForKind(kind, resultType, response.statusCode, bodyTransform);

  if (headers.length > 0 && kind === "json") {
    const entries = headers.map(emitResponseHeaderEntry).join(", ");
    const transform = bodyTransform
      ? `, (body) => ${emitResponseBodyTransform("body", bodyTransform)}`
      : "";
    return `ResponseEncoders.jsonWithHeaders<${resultType}>(${response.statusCode}, [${entries}]${transform})`;
  }

  return encoder;
}

function shouldUseVariantEncoder(response: SuccessResponseVariant): boolean {
  return (
    !response.hasBody ||
    response.body?.bodyKind === "file" ||
    response.dynamicStatus !== undefined ||
    response.bodyProperty !== undefined ||
    response.omitProperties.length > 0
  );
}

interface ResponseBodyTransform {
  readonly serializer: string;
  readonly bodyType: string;
  readonly optional: boolean;
  readonly path: string;
}

function getResponseBodyTransform(
  ctx: EmitterCtx,
  op: HttpOperation,
  response: SuccessResponseVariant,
  kind: Exclude<ResponseEncoderKind, "unsupported">,
): ResponseBodyTransform | undefined {
  if (kind !== "json" && kind !== "text") return undefined;
  return getResponseWireTransform(ctx, op, response, kind === "text" ? "text" : "value");
}

function getResponseWireTransform(
  ctx: EmitterCtx,
  op: HttpOperation,
  response: SuccessResponseVariant,
  encodingContext: "value" | "text",
): ResponseBodyTransform | undefined {
  const body = response.body;
  const serializationType = response.serializationType;
  if (!body || body.bodyKind !== "single" || !serializationType) return undefined;

  const reason = unsupportedJsonWireTransformReason(
    ctx,
    serializationType,
    response.projection,
    new Set(),
    body.property,
  );
  if (reason) {
    if (encodingContext === "text") {
      reportUnsupportedResponseBody(ctx, op, response, reason);
    } else {
      $lib.reportDiagnostic(ctx.program, {
        code: "unsupported-json-serialization",
        format: { operation: op.operation.name, reason },
        target: body.property ?? op.operation,
      });
    }
    return undefined;
  }

  const serializer = emitJsonWireSerializer(
    ctx,
    serializationType,
    response.projection,
    body.property,
    encodingContext,
  );
  if (!serializer) return undefined;
  return {
    serializer,
    bodyType: payloadTypeToTs(ctx, serializationType, response.projection),
    optional: body.property?.optional === true,
    path: response.bodyProperty
      ? tsPropertyAccess("$response", response.bodyProperty)
      : "$response",
  };
}

function emitResponseBodyTransform(value: string, transform: ResponseBodyTransform): string {
  const serialized = `${transform.serializer}.serialize(${value} as ${transform.bodyType}, ${JSON.stringify(transform.path)})`;
  return transform.optional ? `${value} === undefined ? undefined : ${serialized}` : serialized;
}

interface SuccessResponseVariant {
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
  readonly model?: Model;
  readonly tsType: string;
  readonly hiddenProperties: ReadonlySet<string>;
  readonly serializationType?: Type;
  readonly projection?: PayloadProjection;
}

type ResponseStatusContract = number | HttpStatusCodeRange;

interface DynamicResponseStatusPlan {
  readonly property: ModelProperty;
  readonly allowed: readonly ResponseStatusContract[];
}

function collectResponseVariants(ctx: EmitterCtx, op: HttpOperation): SuccessResponseVariant[] {
  const variants: SuccessResponseVariant[] = [];

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
      const dynamicStatus = getDynamicResponseStatusPlan(ctx, content);
      const bodyProperty = getResponseBodyProperty(ctx, content);
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
      const projection = body ? getResponseBodyProjection(ctx, content) : undefined;
      const serializationType = getResponseSerializationType(ctx, resp, content);

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
          model: variantModel,
          tsType: responseContentToTs(ctx, resp, content),
          hiddenProperties,
          serializationType,
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

function deduplicateDynamicStatusVariants(
  variants: readonly SuccessResponseVariant[],
): SuccessResponseVariant[] {
  const deduplicated: SuccessResponseVariant[] = [];
  for (const variant of variants) {
    if (
      variant.dynamicStatus &&
      deduplicated.some(
        (existing) =>
          existing.dynamicStatus?.property === variant.dynamicStatus?.property &&
          existing.tsType === variant.tsType &&
          existing.hasBody === variant.hasBody &&
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
  resp: HttpOperationResponse,
  content: HttpOperationResponse["responses"][number],
): string {
  const body = content.body;
  const headers = content.properties.filter((property) => property.kind === "header");
  const dynamicStatus = getDynamicResponseStatusPlan(ctx, content);
  const bodyProperty = getResponseBodyProperty(ctx, content);
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

  const projection = getResponseBodyProjection(ctx, content);
  const bodyContext = getPayloadBodyContext(body, content.properties);

  if (!bodyProperty && bodyContext !== "explicit" && headers.length === 0 && !dynamicStatus) {
    // A single implicit response can project the named source model directly.
    // TypeSpec often gives `content.body.type` as an already-filtered anonymous
    // model, which would otherwise discard reusable recursive/generic identity.
    const sourceBodyType = getResponseSerializationType(ctx, resp, content) ?? body.type;
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
  ctx: EmitterCtx,
  resp: HttpOperationResponse,
  content: HttpOperationResponseContent,
): Type | undefined {
  const body = content.body;
  if (!body) return undefined;

  const headers = content.properties.filter((property) => property.kind === "header");
  const dynamicStatus = getDynamicResponseStatusPlan(ctx, content);
  const bodyProperty = getResponseBodyProperty(ctx, content);
  const bodyContext = getPayloadBodyContext(body, content.properties);
  if (
    !bodyProperty &&
    bodyContext === "implicit" &&
    headers.length === 0 &&
    !dynamicStatus &&
    resp.responses.length === 1 &&
    resp.type.kind === "Model"
  ) {
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

  const projection = getResponseBodyProjection(ctx, content);
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
  return `(value) => ${serializer}.serialize(value as ${type}, ${JSON.stringify(path)})`;
}

function headerTypeHasScalarEncoding(ctx: EmitterCtx, type: Type, target?: ModelProperty): boolean {
  switch (type.kind) {
    case "Scalar":
      return resolveScalarEncoding(ctx, type, target, "header").status === "supported";
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

function emitResponseHeaderEntry(header: ResponseHeader): string {
  const fields = [JSON.stringify(header.property), JSON.stringify(header.header)];
  if (header.explode || header.transform) fields.push(String(header.explode));
  if (header.transform) fields.push(header.transform);
  return `[${fields.join(", ")}]`;
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

  const statusBranches = resolveDynamicStatusBranches(ctx, [...pending]);
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

  for (const response of [...pending]) {
    const condition = emitDirectTypeCondition(ctx, response);
    if (!condition) continue;
    branches.push({ response, condition });
    pending.delete(response);
  }

  if (pending.size === 0) return branches;

  const objectResponses = [...pending].filter(
    (response) => response.model && !isArrayModelType(ctx.program, response.model),
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

function resolveDynamicStatusBranches(
  ctx: EmitterCtx,
  responses: readonly SuccessResponseVariant[],
): ResponseBranch[] | "ambiguous" | undefined {
  if (responses.length < 2) return undefined;

  const dynamicResponses = responses.filter((response) => response.dynamicStatus);
  if (dynamicResponses.length === 0) return undefined;
  const fixedResponses = responses.filter((response) => !response.dynamicStatus);
  // Status alone cannot distinguish multiple fixed variants. Leave the full
  // set to the existing body/discriminator dispatch in that case.
  if (fixedResponses.length > 1) return undefined;

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
  if (fixedResponse) {
    branches.push({
      response: fixedResponse,
      condition: emitAbsentStatusPropertiesCondition(statusProperties),
    });
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
  const property = JSON.stringify(status.property.name);
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
    .map((name) => `!Object.prototype.hasOwnProperty.call(result, ${JSON.stringify(name)})`)
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
    .map((property) => `!Object.prototype.hasOwnProperty.call(result, ${JSON.stringify(property)})`)
    .join(" && ");
  return `typeof result !== "object" || result === null || (${absent})`;
}

function responseHasOpenHandlerProperties(response: SuccessResponseVariant): boolean {
  return (
    response.bodyProperty === undefined &&
    response.model !== undefined &&
    getAdditionalPropertiesValue(response.model) !== undefined &&
    !isNeverAdditionalProperties(response.model)
  );
}

function responseExposesHandlerProperty(
  ctx: EmitterCtx,
  response: SuccessResponseVariant,
  propertyName: string,
): boolean {
  if (response.headers.some((header) => header.property === propertyName)) return true;
  if (response.bodyProperty !== undefined) return response.bodyProperty === propertyName;

  if (responseHasOpenHandlerProperties(response)) return true;

  const property = getResponseProperty(response, propertyName);
  return property !== undefined && !isResponseDispatchMetadata(ctx, response, propertyName);
}

function emitDirectTypeCondition(
  ctx: EmitterCtx,
  response: SuccessResponseVariant,
): string | undefined {
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
    const cast =
      response.bodyProperty === undefined ? subject : `(${subject} as Record<string, unknown>)`;
    const base = `${JSON.stringify(field)} in ${cast} && ${cast}[${JSON.stringify(field)}] === ${JSON.stringify(prop.type.value)}`;
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
  const cast =
    response.bodyProperty === undefined ? subject : `(${subject} as Record<string, unknown>)`;
  const propertyChecks = [
    `${JSON.stringify(requiredProperty)} in ${cast}`,
    ...excludedProperties.map((prop) => `!(${JSON.stringify(prop)} in ${cast})`),
  ];
  if (response.bodyProperty === undefined) {
    return [`typeof ${subject} === "object"`, `${subject} !== null`, ...propertyChecks].join(
      " && ",
    );
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

function findModelDiscriminator(ctx: EmitterCtx, model: Model | undefined): string | undefined {
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
      : classifyResponseVariant(ctx, op, branch.response);
    const branchEncoder =
      kind === "unsupported"
        ? emitUnsupportedEncoder(
            branch.response.tsType,
            op.operation.name,
            branch.response.contentType,
          )
        : `ResponseEncoders.variant<${branch.response.tsType}>(${emitResponseVariant(
            kind,
            branch.response,
            getResponseBodyTransform(ctx, op, branch.response, kind),
          )})`;
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
  bodyTransform?: ResponseBodyTransform,
): string {
  const fields = [`status: ${emitResponseStatus(response)}`];
  if (kind !== "json") fields.push(`kind: ${JSON.stringify(kind)}`);
  if (response.contentType) fields.push(`contentType: ${JSON.stringify(response.contentType)}`);
  if (response.fileContentTypes.length > 0) {
    fields.push(`contentTypes: ${JSON.stringify(response.fileContentTypes)}`);
  }
  if (response.fileContentTypeRequired) fields.push("requireFileContentType: true");
  if (response.fileNameRequired) fields.push("requireFileName: true");
  if (!response.emitFileContentDisposition) fields.push("emitFileContentDisposition: false");
  if (response.bodyProperty) fields.push(`body: ${JSON.stringify(response.bodyProperty)}`);
  if (response.headers.length > 0) {
    const headers = response.headers.map(emitResponseHeaderEntry).join(", ");
    fields.push(`headers: [${headers}]`);
  }
  if (response.omitProperties.length > 0) {
    fields.push(
      `omit: [${response.omitProperties.map((name) => JSON.stringify(name)).join(", ")}]`,
    );
  }
  if (bodyTransform) {
    fields.push(`transformBody: (body) => ${emitResponseBodyTransform("body", bodyTransform)}`);
  }
  return `{ ${fields.join(", ")} }`;
}

function emitResponseStatus(response: SuccessResponseVariant): string {
  if (!response.dynamicStatus) return String(response.statusCode);
  const allowed = response.dynamicStatus.allowed
    .map((status) =>
      typeof status === "number"
        ? String(status)
        : `{ start: ${status.start}, end: ${status.end} }`,
    )
    .join(", ");
  return `{ property: ${JSON.stringify(response.dynamicStatus.property.name)}, allowed: [${allowed}] }`;
}

type ResponseEncoderKind = "json" | "text" | "bytes" | "file" | "empty" | "unsupported";

function classifyResponseVariant(
  ctx: EmitterCtx,
  op: HttpOperation,
  response: SuccessResponseVariant,
): ResponseEncoderKind {
  if (!response.hasBody) return "empty";

  const body = response.body;
  if (body?.bodyKind === "file") {
    const reason = unsupportedFileContentsReason(ctx.program, body);
    if (!reason) return "file";
    reportUnsupportedResponseBody(ctx, op, response, reason);
    return "unsupported";
  }
  if (body && body.bodyKind !== "single") {
    reportUnsupportedResponseBody(
      ctx,
      op,
      response,
      `${body.bodyKind} bodies require a dedicated response encoder`,
    );
    return "unsupported";
  }

  const kind = classifyResponseContentType(ctx, op, response.contentType);
  if (kind === "unsupported") return kind;

  const reason = incompatibleResponseBodyReason(ctx, response, kind);
  if (!reason) return kind;

  reportUnsupportedResponseBody(ctx, op, response, reason);
  return "unsupported";
}

function reportUnsupportedResponseBody(
  ctx: EmitterCtx,
  op: HttpOperation,
  response: SuccessResponseVariant,
  reason: string,
): void {
  $lib.reportDiagnostic(ctx.program, {
    code: "unsupported-response-body",
    format: {
      contentType:
        response.body?.bodyKind === "file"
          ? response.fileContentTypes.join(", ") || "*/*"
          : (response.contentType ?? "application/json"),
      operationName: op.operation.name,
      reason,
    },
    target: response.body?.property ?? op.operation,
  });
}

function incompatibleResponseBodyReason(
  ctx: EmitterCtx,
  response: SuccessResponseVariant,
  kind: Exclude<ResponseEncoderKind, "empty" | "unsupported">,
): string | undefined {
  const body = response.body;
  if (!body) return "a response encoder was selected for an absent body";
  if (body.bodyKind !== "single") return `${body.bodyKind} bodies are not single-value bodies`;

  switch (kind) {
    case "json":
      return undefined;
    case "text": {
      if (body.type.kind === "Scalar") {
        const encoding = resolveScalarEncoding(ctx, body.type, body.property, "text");
        if (encoding.status === "supported") return undefined;
      }
      return isTextResponseType(body.type)
        ? undefined
        : "text responses require a scalar, literal, enum, or union of those types";
    }
    case "bytes":
      if (body.type.kind === "Scalar") {
        const encoding = resolveScalarEncoding(ctx, body.type, body.property, "binary");
        if (encoding.status === "supported") {
          return `binary responses cannot apply scalar encoding ${JSON.stringify(
            encoding.plan.encoding,
          )}; use a textual or JSON media type`;
        }
      }
      return isBytesScalar(body.type)
        ? undefined
        : "binary responses require the TypeSpec bytes scalar";
    case "file":
      return "file responses require a resolved TypeSpec HTTP File body";
  }
}

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
): Exclude<ResponseEncoderKind, "empty"> {
  if (!contentType) return "json";
  const mediaType = normalizeMediaType(contentType);
  if (mediaType && isJsonMediaType(mediaType)) return "json";
  if (mediaType && isTextMediaType(mediaType)) return "text";
  if (mediaType === "application/octet-stream") return "bytes";

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
  bodyTransform?: ResponseBodyTransform,
): string {
  switch (kind) {
    case "empty":
      return `ResponseEncoders.empty(${status})`;
    case "text":
      return bodyTransform
        ? `ResponseEncoders.text(${status}).mapInput((value: ${tsType}) => String(${emitResponseBodyTransform("value", bodyTransform)}))`
        : `ResponseEncoders.text(${status})`;
    case "bytes":
      return `ResponseEncoders.bytes(${status})`;
    case "file":
      return `ResponseEncoders.file(${status})`;
    case "json":
      return bodyTransform
        ? `ResponseEncoders.json<unknown>(${status}).mapInput((value: ${tsType}) => ${emitResponseBodyTransform("value", bodyTransform)})`
        : `ResponseEncoders.json<${tsType}>(${status})`;
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
  readonly explode: boolean;
  readonly transform?: string;
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
