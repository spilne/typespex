import {
  getEncode,
  getMaxValueAsNumeric,
  getMaxValueExclusiveAsNumeric,
  getMinValueAsNumeric,
  getMinValueExclusiveAsNumeric,
  isArrayModelType,
  isErrorModel,
  resolveEncodedName,
  serializeValueAsJson,
  walkPropertiesInherited,
  type EncodeData,
  type Model,
  type ModelProperty,
  type Program,
  type Type,
  type VisibilityProvider,
} from "@typespec/compiler";
import type {
  Authentication,
  HttpAuth,
  HttpOperation,
  HttpOperationBody,
  HttpOperationParameter,
  HttpOperationResponse,
  HttpOperationResponseContent,
  HttpPayloadBody,
  HttpServer,
} from "@typespec/http";
import type { StreamMetadata } from "@typespec/http/experimental";
import {
  CODEGEN_PLAN_VERSION,
  type HttpAuthAlternativePlan,
  type HttpAuthSchemePlan,
  type HttpBodyPlan,
  type HttpMultipartPartPlan,
  type HttpParameterPlan,
  type HttpResponsePlan,
  type HttpResponseMultipartPartPlan,
  type HttpServerPlan,
  type HttpWireValuePlan,
  type HttpWireOperationPlan,
} from "@typespex/codegen/unstable";

export interface HttpPlanningApi {
  readonly getServers: (
    program: Program,
    type: import("@typespec/compiler").Namespace,
  ) => HttpServer[] | undefined;
  readonly getStreamMetadata: (
    program: Program,
    source: HttpOperation["parameters"] | HttpOperationResponseContent,
  ) => StreamMetadata | undefined;
  readonly HttpVisibilityProvider: (verb: HttpOperation["verb"]) => VisibilityProvider;
}

export interface BridgeStreamAnalysis {
  readonly elementTypes: ReadonlyMap<Model, Type>;
  readonly typeSubstitutions: ReadonlyMap<Model, Type>;
  readonly issues: readonly { readonly operation: HttpOperation; readonly message: string }[];
}

export function analyzeBridgeStreams(
  program: Program,
  operations: readonly HttpOperation[],
  api: HttpPlanningApi,
): BridgeStreamAnalysis {
  const elementTypes = new Map<Model, Type>();
  const typeSubstitutions = new Map<Model, Type>();
  const issues: { operation: HttpOperation; message: string }[] = [];
  for (const operation of operations) {
    for (const parameter of operation.parameters.parameters) {
      if (parameter.type === "path" && parameter.style === "fragment") {
        issues.push({
          operation,
          message: `path parameter ${JSON.stringify(parameter.name)} uses fragment style, which is not sent in HTTP requests`,
        });
      }
    }
    if (hasLiteralFragment(operation.uriTemplate)) {
      issues.push({
        operation,
        message: "literal URI fragments are not sent in HTTP requests",
      });
    }
    addMultipartSubstitutions(operation.parameters.body);
    analyzeBody(operation, operation.parameters.body, "request");
    addStream(operation, api.getStreamMetadata(program, operation.parameters), [
      operation.operation.parameters,
      operation.parameters.body?.type,
    ]);
    for (const response of operation.responses) {
      for (const content of response.responses) {
        addMultipartSubstitutions(content.body);
        analyzeBody(operation, content.body, "response");
        addStream(operation, api.getStreamMetadata(program, content), [
          response.type,
          content.body?.type,
        ]);
      }
    }
  }
  return { elementTypes, typeSubstitutions, issues };

  function addMultipartSubstitutions(body: HttpPayloadBody | undefined): void {
    if (body?.bodyKind !== "multipart") return;
    for (const [index, part] of body.parts.entries()) {
      let wrapper: Type | undefined =
        part.partKind === "model"
          ? part.property.type
          : body.type.kind === "Tuple"
            ? body.type.values[index]
            : undefined;
      if (part.multi && wrapper?.kind === "Model" && isArrayModelType(program, wrapper)) {
        wrapper = wrapper.indexer.value;
      }
      if (wrapper?.kind === "Model") typeSubstitutions.set(wrapper, part.body.type);
    }
  }

  function analyzeBody(
    operation: HttpOperation,
    body: HttpPayloadBody | undefined,
    direction: string,
  ): void {
    if (!body) return;
    if (body.bodyKind === "multipart") {
      for (const part of body.parts)
        analyzeBody(operation, part.body, `${direction} multipart part`);
      return;
    }
    if (body.bodyKind === "file") return;
    const contentTypes =
      body.contentTypes.length > 0 ? body.contentTypes : defaultBodyContentTypes(body);
    for (const contentType of contentTypes) {
      const kind = bodyKind(program, body, contentType);
      if (kind === "binary" && !isBytesLike(program, body.type)) {
        addIssue(
          operation,
          `${direction} body ${contentType} is structured but the HTTP bridge has no serializer for that media type`,
        );
      } else if (kind === "text" && !isScalarLike(program, body.type)) {
        addIssue(
          operation,
          `${direction} body ${contentType} is structured; only scalar text bodies are supported`,
        );
      } else if (kind === "form" && body.type.kind !== "Model") {
        addIssue(operation, `${direction} form body must be an object model`);
      }
    }
  }

  function addIssue(operation: HttpOperation, message: string): void {
    if (issues.some((issue) => issue.operation === operation && issue.message === message)) return;
    issues.push({ operation, message });
  }

  function addStream(
    operation: HttpOperation,
    stream: StreamMetadata | undefined,
    associatedTypes: readonly (Type | undefined)[],
  ): void {
    if (!stream) return;
    if (
      stream.contentTypes.length === 0 ||
      stream.contentTypes.some(
        (contentType) => normalizeMediaType(contentType) !== "application/jsonl",
      )
    ) {
      issues.push({
        operation,
        message: "streaming tools require application/jsonl so MCP can expose a bounded array",
      });
      return;
    }
    if (stream.originalType.kind === "Model")
      elementTypes.set(stream.originalType, stream.streamType);
    if (stream.bodyType.kind === "Model") elementTypes.set(stream.bodyType, stream.streamType);
    for (const type of associatedTypes) {
      if (type?.kind === "Model") elementTypes.set(type, stream.streamType);
    }
  }
}

export function createHttpWireOperationPlan(
  program: Program,
  operation: HttpOperation,
  operationId: string,
  serviceNamespace: import("@typespec/compiler").Namespace,
  api: HttpPlanningApi,
  serviceAuthentication?: Authentication,
): HttpWireOperationPlan {
  return {
    version: CODEGEN_PLAN_VERSION,
    operationId,
    method: operation.verb.toUpperCase(),
    path: operation.path,
    ...(extractLiteralQuery(operation.uriTemplate).length > 0
      ? { literalQuery: extractLiteralQuery(operation.uriTemplate) }
      : {}),
    parameters: operation.parameters.parameters.map((parameter) =>
      createParameterPlan(program, operation, parameter),
    ),
    ...(operation.parameters.body
      ? { requestBody: createBodyPlan(program, operation, operation.parameters.body, api) }
      : {}),
    responses: operation.responses.flatMap((response) =>
      createResponsePlans(program, response, api),
    ),
    ...(createServerPlans(program, api.getServers(program, serviceNamespace)) as
      | { servers: readonly HttpServerPlan[] }
      | {}),
    ...(createAuthPlans(operation.authentication ?? serviceAuthentication) as
      | { auth: readonly HttpAuthAlternativePlan[] }
      | {}),
  };
}

function createParameterPlan(
  program: Program,
  operation: HttpOperation,
  parameter: HttpOperationParameter,
): HttpParameterPlan {
  const path = findPropertyPath(
    operation.parameters.properties,
    (property) => property.property === parameter.param && property.kind === parameter.type,
  ) ?? [parameter.param.name];
  const source = wirePath(program, operation.operation.parameters, path, "application/json");
  const value = createHttpWireValuePlan(
    program,
    parameter.param.type,
    parameter.param,
    "text/plain",
    parameter.type === "header" ? "header" : "text",
  );
  return {
    source,
    wireName: parameter.name,
    location: parameter.type,
    required: !parameter.param.optional,
    value,
    ...(parameter.type === "path"
      ? {
          style: normalizePathStyle(parameter.style),
          explode: parameter.explode,
          allowReserved: parameter.allowReserved,
        }
      : parameter.type === "query"
        ? { style: "form" as const, explode: parameter.explode }
        : parameter.type === "header"
          ? { style: "simple" as const, explode: parameter.explode }
          : { style: "form" as const, explode: true }),
  };
}

function createBodyPlan(
  program: Program,
  operation: HttpOperation,
  body: HttpPayloadBody,
  api: HttpPlanningApi,
): HttpBodyPlan {
  const contentTypes =
    body.contentTypes.length > 0 ? body.contentTypes : defaultBodyContentTypes(body);
  const stream = api.getStreamMetadata(program, operation.parameters);
  const kind = stream ? "jsonl" : bodyKind(program, body, contentTypes[0]);
  const contentTypePropertyPath = body.contentTypeProperty
    ? findPropertyPath(
        operation.parameters.properties,
        (property) => property.property === body.contentTypeProperty,
      )
    : undefined;
  const contentTypeSource = contentTypePropertyPath
    ? wirePath(program, operation.operation.parameters, contentTypePropertyPath, "application/json")
    : undefined;
  const mediaTypes = contentTypes.map((contentType) => ({
    contentType,
    kind: stream ? ("jsonl" as const) : bodyKind(program, body, contentType),
    ...(body.bodyKind === "file" || body.bodyKind === "multipart"
      ? {}
      : {
          value: createHttpWireValuePlan(
            program,
            body.type,
            body.property,
            contentType,
            httpValueContext(program, body, contentType),
          ),
        }),
  }));
  const multipartParts =
    body.bodyKind === "multipart" ? createMultipartPartPlans(program, operation, body) : undefined;
  const valuePlan =
    body.bodyKind === "file" || body.bodyKind === "multipart"
      ? undefined
      : createHttpWireValuePlan(
          program,
          body.type,
          body.property,
          contentTypes[0],
          httpValueContext(program, body, contentTypes[0]),
        );
  const bodyPropertyPath = body.property
    ? findPropertyPath(
        operation.parameters.properties,
        (property) => property.property === body.property,
      )
    : undefined;
  const canUseDirectSource =
    bodyPropertyPath &&
    (body.bodyKind !== "single" || !(body as HttpOperationBody).containsMetadataAnnotations);
  if (canUseDirectSource) {
    return {
      source: wirePath(
        program,
        operation.operation.parameters,
        bodyPropertyPath,
        "application/json",
      ),
      kind,
      contentTypes,
      ...(contentTypeSource ? { contentTypeSource } : {}),
      ...(contentTypeSource || mediaTypes.length > 1 ? { mediaTypes } : {}),
      ...(multipartParts ? { multipartParts } : {}),
      ...(valuePlan ? { value: valuePlan } : {}),
    };
  }

  const prefix = bodyPropertyPath ?? [];
  const contentType = contentTypes[0] ?? "application/json";
  const fields = operation.parameters.properties
    .filter((property) => property.kind === "bodyProperty")
    .filter((property) => pathStartsWith(property.path, prefix))
    .map((property) => {
      const relative = property.path.slice(prefix.length);
      return {
        source: wirePath(
          program,
          operation.operation.parameters,
          property.path,
          "application/json",
        ),
        target: wirePath(program, body.type, relative, contentType),
      };
    });
  return {
    ...(fields.length > 0 ? { fields } : { source: [] }),
    kind,
    contentTypes,
    ...(contentTypeSource ? { contentTypeSource } : {}),
    ...(contentTypeSource || mediaTypes.length > 1 ? { mediaTypes } : {}),
    ...(multipartParts ? { multipartParts } : {}),
    ...(valuePlan ? { value: valuePlan } : {}),
  };
}

function createMultipartPartPlans(
  program: Program,
  operation: HttpOperation,
  body: Extract<HttpPayloadBody, { bodyKind: "multipart" }>,
): HttpMultipartPartPlan[] {
  const bodyPath = findPropertyPath(
    operation.parameters.properties,
    (property) => property.property === body.property,
  ) ?? [body.property.name];
  return body.parts.map((part, index) => {
    const sourcePath =
      part.partKind === "model" ? [...bodyPath, part.property.name] : [...bodyPath, index];
    const contentTypes =
      part.body.contentTypes.length > 0
        ? [...part.body.contentTypes]
        : defaultBodyContentTypes(part.body);
    const kind = bodyKind(program, part.body, contentTypes[0]);
    return {
      source: wirePath(program, operation.operation.parameters, sourcePath, "application/json"),
      ...(part.name ? { name: part.name } : {}),
      multi: part.multi,
      optional: part.optional,
      kind: kind === "multipart" || kind === "form" || kind === "jsonl" ? "binary" : kind,
      contentTypes,
      ...(part.body.bodyKind === "file"
        ? {}
        : {
            value: createHttpWireValuePlan(
              program,
              part.body.type,
              part.body.property,
              contentTypes[0],
              httpValueContext(program, part.body, contentTypes[0]),
            ),
          }),
    };
  });
}

function createResponseMultipartPartPlans(
  program: Program,
  body: Extract<HttpPayloadBody, { bodyKind: "multipart" }>,
): HttpResponseMultipartPartPlan[] {
  return body.parts.map((part, index) => {
    const contentTypes =
      part.body.contentTypes.length > 0
        ? [...part.body.contentTypes]
        : defaultBodyContentTypes(part.body);
    const kind = bodyKind(program, part.body, contentTypes[0]);
    return {
      target:
        part.partKind === "model"
          ? [resolveEncodedName(program, part.property, "application/json")]
          : [index],
      ...(part.name ? { name: part.name } : {}),
      multi: part.multi,
      optional: part.optional,
      kind: kind === "multipart" || kind === "form" || kind === "jsonl" ? "binary" : kind,
      contentTypes,
      ...(part.body.bodyKind === "file"
        ? {}
        : {
            value: createHttpWireValuePlan(
              program,
              part.body.type,
              part.body.property,
              contentTypes[0],
              httpValueContext(program, part.body, contentTypes[0]),
            ),
          }),
    };
  });
}

function createResponsePlans(
  program: Program,
  response: HttpOperationResponse,
  api: HttpPlanningApi,
): HttpResponsePlan[] {
  const statusCodes = normalizeStatusCodes(response.statusCodes);
  const error = typeContainsError(program, response.type);
  if (response.responses.length === 0) {
    return [{ statusCodes, contentTypes: [], kind: "empty", error }];
  }
  return response.responses.flatMap((content) => {
    const body = content.body;
    const stream = api.getStreamMetadata(program, content);
    const contentTypes = body?.contentTypes ?? [];
    const mediaGroups =
      contentTypes.length > 0
        ? groupMediaTypesByKind(program, body, contentTypes, Boolean(stream))
        : [
            {
              kind: body ? bodyKind(program, body, undefined) : ("empty" as const),
              contentTypes: [],
            },
          ];
    const bodyPath = body?.property
      ? findPropertyPath(content.properties, (property) => property.property === body.property)
      : undefined;
    const statusPath = findPropertyPath(
      content.properties,
      (property) => property.kind === "statusCode",
    );
    const contentTypePath = findPropertyPath(
      content.properties,
      (property) => property.kind === "contentType",
    );
    const headers = Object.entries(content.headers ?? {}).flatMap(([wireName, property]) => {
      const path = findPropertyPath(
        content.properties,
        (candidate) => candidate.property === property && candidate.kind === "header",
      );
      return path
        ? [
            {
              wireName,
              target: wirePath(program, response.type, path, "application/json"),
              ...(property.type.kind === "Model" && isArrayModelType(program, property.type)
                ? { collection: true }
                : {}),
              value: createHttpWireValuePlan(
                program,
                property.type,
                property,
                "text/plain",
                "header",
              ),
            },
          ]
        : [];
    });
    return mediaGroups.map(({ kind, contentTypes }): HttpResponsePlan => ({
      statusCodes,
      contentTypes,
      kind: stream ? "jsonl" : kind,
      error,
      ...(body && kind !== "file" && kind !== "multipart"
        ? {
            bodyValue: createHttpWireValuePlan(
              program,
              body.type,
              body.property,
              contentTypes[0] ?? "application/json",
              httpValueContext(program, body, contentTypes[0]),
            ),
          }
        : {}),
      ...(body?.bodyKind === "multipart"
        ? { multipartParts: createResponseMultipartPartPlans(program, body) }
        : {}),
      ...(bodyPath
        ? { bodyTarget: wirePath(program, response.type, bodyPath, "application/json") }
        : {}),
      ...(statusPath
        ? { statusTarget: wirePath(program, response.type, statusPath, "application/json") }
        : {}),
      ...(contentTypePath
        ? {
            contentTypeTarget: wirePath(
              program,
              response.type,
              contentTypePath,
              "application/json",
            ),
          }
        : {}),
      ...(headers.length > 0 ? { headers } : {}),
    }));
  });
}

function createServerPlans(
  program: Program,
  servers: readonly HttpServer[] | undefined,
): { readonly servers: readonly HttpServerPlan[] } | {} {
  if (!servers?.length) return {};
  return {
    servers: servers.map((server) => {
      let url = server.url;
      let fullyDefaulted = true;
      for (const [name, property] of server.parameters) {
        if (property.defaultValue === undefined) {
          fullyDefaulted = false;
          continue;
        }
        const value = serializeValueAsJson(
          program,
          property.defaultValue,
          property.type,
          undefined,
          undefined,
          property,
        );
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
          fullyDefaulted = false;
          continue;
        }
        url = url.replaceAll(`{${name}}`, encodeURIComponent(String(value)));
      }
      return { url, fullyDefaulted };
    }),
  };
}

function createAuthPlans(
  authentication: Authentication | undefined,
): { readonly auth: readonly HttpAuthAlternativePlan[] } | {} {
  if (!authentication?.options.length) return {};
  return {
    auth: authentication.options.map((option): HttpAuthAlternativePlan => {
      if (option.schemes.some((scheme) => scheme.type === "noAuth")) return { noAuth: true };
      return {
        schemes: option.schemes
          .map(authSchemePlan)
          .filter((scheme): scheme is HttpAuthSchemePlan => scheme !== undefined),
      };
    }),
  };
}

function authSchemePlan(auth: HttpAuth): HttpAuthSchemePlan | undefined {
  switch (auth.type) {
    case "noAuth":
      return undefined;
    case "apiKey":
      return { id: auth.id, type: "apiKey", location: auth.in, name: auth.name };
    case "http":
      return { id: auth.id, type: "http", scheme: auth.scheme };
    case "oauth2":
      return { id: auth.id, type: "oauth2" };
    case "openIdConnect":
      return { id: auth.id, type: "openIdConnect" };
  }
}

function groupMediaTypesByKind(
  program: Program,
  body: HttpPayloadBody | undefined,
  contentTypes: readonly string[],
  stream: boolean,
): { readonly kind: HttpResponsePlan["kind"]; readonly contentTypes: string[] }[] {
  return contentTypes.map((contentType) => ({
    kind: stream ? "jsonl" : bodyKind(program, body, contentType),
    contentTypes: [contentType],
  }));
}

function bodyKind(
  program: Program,
  body: HttpPayloadBody | undefined,
  contentType: string | undefined,
): HttpBodyPlan["kind"] {
  if (body?.bodyKind === "file") return "file";
  if (body?.bodyKind === "multipart") return "multipart";
  const mediaType = normalizeMediaType(contentType ?? "application/json");
  if (mediaType === "application/jsonl" || mediaType === "application/x-ndjson") return "jsonl";
  if (mediaType === "application/x-www-form-urlencoded") return "form";
  if (mediaType?.startsWith("multipart/")) return "multipart";
  if (mediaType === "application/json" || mediaType?.endsWith("+json")) return "json";
  if (body && isBytesLike(program, body.type)) return "binary";
  if (mediaType === "application/xml" || mediaType === "text/xml" || mediaType?.endsWith("+xml"))
    return "text";
  if (mediaType?.startsWith("text/")) return "text";
  return "binary";
}

function defaultBodyContentTypes(body: HttpPayloadBody): string[] {
  if (body.bodyKind === "multipart") return ["multipart/form-data"];
  if (body.bodyKind === "file")
    return body.contentTypes.length > 0 ? [...body.contentTypes] : ["application/octet-stream"];
  return ["application/json"];
}

type HttpValueContext = "value" | "text" | "header" | "binary";

function httpValueContext(
  program: Program,
  body: HttpPayloadBody,
  contentType: string | undefined,
): HttpValueContext {
  if (body.bodyKind === "file") return "binary";
  const kind = bodyKind(program, body, contentType);
  return kind === "json" || kind === "jsonl"
    ? "value"
    : kind === "binary" || kind === "file"
      ? "binary"
      : "text";
}

function normalizeMediaType(contentType: string): string {
  return contentType.split(";", 1)[0]!.trim().toLowerCase();
}

function isScalarLike(program: Program, type: Type): boolean {
  switch (type.kind) {
    case "Scalar":
    case "String":
    case "StringTemplate":
    case "Number":
    case "Boolean":
    case "EnumMember":
      return true;
    case "Enum":
      return true;
    case "Union":
      return [...type.variants.values()].every((variant) => isScalarLike(program, variant.type));
    case "UnionVariant":
    case "ModelProperty":
      return isScalarLike(program, type.type);
    case "Intrinsic":
      return type.name === "null";
    default:
      return false;
  }
}

function isBytesLike(program: Program, type: Type): boolean {
  switch (type.kind) {
    case "Scalar":
      return scalarIntrinsic(program, type) === "bytes";
    case "Union":
      return [...type.variants.values()].every((variant) => isBytesLike(program, variant.type));
    case "UnionVariant":
    case "ModelProperty":
      return isBytesLike(program, type.type);
    default:
      return false;
  }
}

function normalizePathStyle(
  style: "simple" | "label" | "matrix" | "fragment" | "path",
): "simple" | "label" | "matrix" | "path" {
  return style === "label" || style === "matrix" || style === "path" ? style : "simple";
}

function createHttpWireValuePlan(
  program: Program,
  type: Type,
  encodingTarget: ModelProperty | import("@typespec/compiler").Scalar | undefined,
  sourceContentType: string | undefined,
  context: HttpValueContext = "value",
): HttpWireValuePlan {
  return createHttpWireValuePlanInner(program, type, encodingTarget, sourceContentType, context, {
    visiting: new Set(),
    recursive: new Set(),
    names: new Map(),
    nextName: 0,
  });
}

interface HttpWirePlanningState {
  readonly visiting: Set<Model>;
  readonly recursive: Set<Model>;
  readonly names: Map<Model, string>;
  nextName: number;
}

function createHttpWireValuePlanInner(
  program: Program,
  type: Type,
  encodingTarget: ModelProperty | import("@typespec/compiler").Scalar | undefined,
  sourceContentType: string | undefined,
  context: HttpValueContext,
  state: HttpWirePlanningState,
): HttpWireValuePlan {
  const mediaType = sourceContentType ?? "application/json";
  switch (type.kind) {
    case "Model": {
      if (state.visiting.has(type)) {
        state.recursive.add(type);
        return { kind: "ref", name: httpWireDefinitionName(type, state) };
      }
      if (isHttpFileModel(type)) {
        const contentType = inheritedProperty(type, "contentType");
        const filename = inheritedProperty(type, "filename");
        const contents = inheritedProperty(type, "contents");
        if (!contents) return { kind: "identity" };
        return {
          kind: "file-json",
          ...(contentType
            ? { contentTypeSource: resolveEncodedName(program, contentType, mediaType) }
            : {}),
          ...(filename ? { filenameSource: resolveEncodedName(program, filename, mediaType) } : {}),
          contentsSource: resolveEncodedName(program, contents, mediaType),
          textContents:
            contents.type.kind === "Scalar" && scalarIntrinsic(program, contents.type) === "string",
        };
      }
      state.visiting.add(type);
      let value: HttpWireValuePlan;
      if (isArrayModelType(program, type)) {
        value = {
          kind: "array",
          item: createHttpWireValuePlanInner(
            program,
            type.indexer.value,
            undefined,
            sourceContentType,
            context,
            state,
          ),
        };
      } else {
        const properties = Object.fromEntries(
          [...walkPropertiesInherited(type)].map((property) => {
            const targetName = resolveEncodedName(program, property, "application/json");
            return [
              targetName,
              {
                sourceName: resolveEncodedName(program, property, mediaType),
                value: createHttpWireValuePlanInner(
                  program,
                  property.type,
                  property,
                  sourceContentType,
                  context,
                  state,
                ),
                optional: property.optional || property.defaultValue !== undefined,
              },
            ];
          }),
        );
        value = {
          kind: "object",
          properties,
          ...(type.indexer?.value
            ? {
                additional: createHttpWireValuePlanInner(
                  program,
                  type.indexer.value,
                  undefined,
                  sourceContentType,
                  context,
                  state,
                ),
              }
            : {}),
        };
      }
      state.visiting.delete(type);
      return state.recursive.has(type)
        ? { kind: "definition", name: httpWireDefinitionName(type, state), value }
        : value;
    }
    case "Scalar": {
      const encoding = scalarHttpEncodingPlan(program, type, encodingTarget, context);
      if (encoding) return encoding;
      const intrinsic = scalarIntrinsic(program, type);
      if (intrinsic === "boolean") return { kind: "boolean" };
      if (
        ["int64", "uint64", "integer"].includes(intrinsic) &&
        integerRangeIsJsonSafe(program, type, encodingTarget ?? type)
      ) {
        return { kind: "number", integer: true };
      }
      if (
        [
          "int8",
          "uint8",
          "int16",
          "uint16",
          "int32",
          "uint32",
          "safeint",
          "float",
          "float32",
          "float64",
        ].includes(intrinsic)
      ) {
        return {
          kind: "number",
          integer: !["float", "float32", "float64"].includes(intrinsic),
        };
      }
      return { kind: "string" };
    }
    case "Enum":
      return {
        kind: "union",
        variants: [...type.members.values()].map((member) => ({
          kind: "literal" as const,
          value: member.value ?? member.name,
        })),
      };
    case "EnumMember":
      return { kind: "literal", value: type.value ?? type.name };
    case "Union":
      return {
        kind: "union",
        variants: [...type.variants.values()].map((variant) =>
          createHttpWireValuePlanInner(
            program,
            variant.type,
            undefined,
            sourceContentType,
            context,
            state,
          ),
        ),
      };
    case "UnionVariant":
      return createHttpWireValuePlanInner(
        program,
        type.type,
        undefined,
        sourceContentType,
        context,
        state,
      );
    case "ModelProperty":
      return createHttpWireValuePlanInner(
        program,
        type.type,
        type,
        sourceContentType,
        context,
        state,
      );
    case "Tuple":
      return {
        kind: "tuple",
        items: type.values.map((item) =>
          createHttpWireValuePlanInner(program, item, undefined, sourceContentType, context, state),
        ),
      };
    case "String":
      return { kind: "literal", value: type.value };
    case "StringTemplate":
      return type.stringValue === undefined
        ? { kind: "string" }
        : { kind: "literal", value: type.stringValue };
    case "Number": {
      const value = type.numericValue.asNumber();
      return value === null ? { kind: "string" } : { kind: "literal", value };
    }
    case "Boolean":
      return { kind: "literal", value: type.value };
    case "Intrinsic":
      return type.name === "null" ? { kind: "null" } : { kind: "identity" };
    default:
      return { kind: "identity" };
  }
}

function httpWireDefinitionName(type: Model, state: HttpWirePlanningState): string {
  const existing = state.names.get(type);
  if (existing) return existing;
  const name = `${type.name || "Model"}#${state.nextName++}`;
  state.names.set(type, name);
  return name;
}

function scalarIntrinsic(program: Program, scalar: import("@typespec/compiler").Scalar): string {
  let current: import("@typespec/compiler").Scalar | undefined = scalar;
  while (current) {
    if (program.checker.isStdType(current)) return current.name;
    current = current.baseScalar;
  }
  return scalar.name;
}

function scalarHttpEncodingPlan(
  program: Program,
  scalar: import("@typespec/compiler").Scalar,
  target: ModelProperty | import("@typespec/compiler").Scalar | undefined,
  context: HttpValueContext,
): HttpWireValuePlan | undefined {
  const intrinsic = scalarIntrinsic(program, scalar);
  const encode = effectiveEncode(program, scalar, target);
  if (!encode) {
    return context === "header" && ["utcDateTime", "offsetDateTime"].includes(intrinsic)
      ? { kind: "scalar-encoding", encoding: "rfc7231" }
      : undefined;
  }
  const wire = scalarIntrinsic(program, encode.type);
  switch (encode.encoding) {
    case undefined:
      if (wire !== "string") return undefined;
      if (intrinsic === "boolean") {
        return { kind: "scalar-encoding", encoding: "boolean-string" };
      }
      if (
        ["numeric", "decimal", "decimal128"].includes(intrinsic) ||
        (["int64", "uint64", "integer"].includes(intrinsic) &&
          !integerRangeIsJsonSafe(program, scalar, target ?? scalar))
      ) {
        return { kind: "string" };
      }
      if (isNumericIntrinsic(intrinsic)) {
        return {
          kind: "scalar-encoding",
          encoding: isIntegerIntrinsic(intrinsic) ? "integer-string" : "number-string",
        };
      }
      return { kind: "string" };
    case "rfc3339":
    case "ISO8601":
    case "base64":
      return { kind: "string" };
    case "rfc7231":
      return { kind: "scalar-encoding", encoding: "rfc7231" };
    case "unixTimestamp":
      return { kind: "scalar-encoding", encoding: "unix-timestamp" };
    case "seconds":
      return { kind: "scalar-encoding", encoding: "duration-seconds" };
    case "milliseconds":
      return { kind: "scalar-encoding", encoding: "duration-milliseconds" };
    case "base64url":
      return { kind: "scalar-encoding", encoding: "base64url" };
    default:
      return undefined;
  }
}

function effectiveEncode(
  program: Program,
  scalar: import("@typespec/compiler").Scalar,
  target: ModelProperty | import("@typespec/compiler").Scalar | undefined,
): EncodeData | undefined {
  if (target?.kind === "ModelProperty") {
    const property = getEncode(program, target);
    if (property) return property;
  }
  let current: import("@typespec/compiler").Scalar | undefined = scalar;
  while (current) {
    const encode = getEncode(program, current);
    if (encode) return encode;
    current = current.baseScalar;
  }
  return undefined;
}

function isNumericIntrinsic(name: string): boolean {
  return (
    isIntegerIntrinsic(name) ||
    ["float", "float32", "float64", "numeric", "decimal", "decimal128"].includes(name)
  );
}

function isIntegerIntrinsic(name: string): boolean {
  return [
    "int8",
    "uint8",
    "int16",
    "uint16",
    "int32",
    "uint32",
    "int64",
    "uint64",
    "integer",
    "safeint",
  ].includes(name);
}

function integerRangeIsJsonSafe(
  program: Program,
  scalar: import("@typespec/compiler").Scalar,
  target: ModelProperty | import("@typespec/compiler").Scalar,
): boolean {
  const minimum =
    getMinValueAsNumeric(program, target) ??
    getMinValueExclusiveAsNumeric(program, target) ??
    (target === scalar
      ? undefined
      : (getMinValueAsNumeric(program, scalar) ?? getMinValueExclusiveAsNumeric(program, scalar)));
  const maximum =
    getMaxValueAsNumeric(program, target) ??
    getMaxValueExclusiveAsNumeric(program, target) ??
    (target === scalar
      ? undefined
      : (getMaxValueAsNumeric(program, scalar) ?? getMaxValueExclusiveAsNumeric(program, scalar)));
  const min = minimum?.asNumber();
  const max = maximum?.asNumber();
  return (
    min !== undefined &&
    min !== null &&
    max !== undefined &&
    max !== null &&
    Number.isSafeInteger(min) &&
    Number.isSafeInteger(max) &&
    min >= Number.MIN_SAFE_INTEGER &&
    max <= Number.MAX_SAFE_INTEGER
  );
}

function isHttpFileModel(model: Model): boolean {
  let current: Model | undefined = model;
  while (current) {
    if (current.name === "File" && current.namespace?.name === "Http") return true;
    current = current.baseModel;
  }
  return false;
}

function inheritedProperty(model: Model, name: string): ModelProperty | undefined {
  return (
    model.properties.get(name) ??
    (model.baseModel ? inheritedProperty(model.baseModel, name) : undefined)
  );
}

function extractLiteralQuery(
  uriTemplate: string,
): { readonly name: string; readonly value: string }[] {
  let depth = 0;
  let queryStart = -1;
  for (let index = 0; index < uriTemplate.length; index += 1) {
    const character = uriTemplate[index];
    if (character === "{") depth += 1;
    else if (character === "}") depth = Math.max(0, depth - 1);
    else if (character === "?" && depth === 0) {
      queryStart = index + 1;
      break;
    }
  }
  if (queryStart < 0) return [];
  const literal = uriTemplate
    .slice(queryStart)
    .split("#", 1)[0]!
    .replaceAll(/\{[^}]*\}/g, "")
    .replace(/^&+|&+$/g, "");
  if (!literal) return [];
  return [...new URLSearchParams(literal)].map(([name, value]) => ({ name, value }));
}

function hasLiteralFragment(uriTemplate: string): boolean {
  let depth = 0;
  for (const character of uriTemplate) {
    if (character === "{") depth += 1;
    else if (character === "}") depth = Math.max(0, depth - 1);
    else if (character === "#" && depth === 0) return true;
  }
  return false;
}

function normalizeStatusCodes(
  statusCodes: HttpOperationResponse["statusCodes"],
): (number | `${number}XX` | "default")[] {
  if (statusCodes === "*") return ["default"];
  if (typeof statusCodes === "number") return [statusCodes];
  if (statusCodes.start % 100 === 0 && statusCodes.end === statusCodes.start + 99) {
    return [`${Math.floor(statusCodes.start / 100)}XX`];
  }
  const values: number[] = [];
  for (let status = statusCodes.start; status <= statusCodes.end; status += 1) values.push(status);
  return values;
}

function typeContainsError(program: Program, type: Type): boolean {
  if (type.kind === "Model") return isErrorModel(program, type);
  if (type.kind === "Union") {
    return [...type.variants.values()].some((variant) => typeContainsError(program, variant.type));
  }
  if (type.kind === "UnionVariant" || type.kind === "ModelProperty") {
    return typeContainsError(program, type.type);
  }
  return false;
}

function findPropertyPath(
  properties: readonly import("@typespec/http").HttpProperty[],
  predicate: (property: import("@typespec/http").HttpProperty) => boolean,
): readonly (string | number)[] | undefined {
  return properties.find(predicate)?.path;
}

function wirePath(
  program: Program,
  root: Type,
  path: readonly (string | number)[],
  contentType: string,
): (string | number)[] {
  const output: (string | number)[] = [];
  let current = root;
  for (const segment of path) {
    if (typeof segment === "number") {
      output.push(segment);
      if (current.kind === "Tuple") current = current.values[segment] ?? current;
      continue;
    }
    const property = modelProperty(current, segment);
    output.push(property ? resolveEncodedName(program, property, contentType) : segment);
    if (property) current = property.type;
  }
  return output;
}

function modelProperty(type: Type, name: string): ModelProperty | undefined {
  if (type.kind === "Model") {
    return (
      type.properties.get(name) ??
      (type.baseModel ? modelProperty(type.baseModel, name) : undefined)
    );
  }
  if (type.kind === "ModelProperty") return modelProperty(type.type, name);
  return undefined;
}

function pathStartsWith(
  path: readonly (string | number)[],
  prefix: readonly (string | number)[],
): boolean {
  return prefix.every((segment, index) => path[index] === segment);
}
