import {
  isArrayModelType,
  isErrorModel,
  resolveEncodedName,
  serializeValueAsJson,
  type ModelProperty,
  type Program,
  type Type,
} from "@typespec/compiler";
import type {
  Authentication,
  HttpAuth,
  HttpOperation,
  HttpOperationBody,
  HttpOperationParameter,
  HttpOperationResponse,
  HttpPayloadBody,
  HttpServer,
} from "@typespec/http";
import {
  HTTP_OPERATION_PLAN_VERSION,
  type HttpAuthAlternativePlan,
  type HttpAuthSchemePlan,
  type HttpBodyPlan,
  type HttpMultipartPartPlan,
  type HttpParameterPlan,
  type HttpResponseMultipartPartPlan,
  type HttpResponsePlan,
  type HttpServerPlan,
  type HttpWireOperationPlan,
} from "@typespex/http-client";
import {
  bodyKind,
  defaultBodyContentTypes,
  httpValueContext,
  normalizePathStyle,
} from "./http-media.js";
import type { HttpPlanningApi } from "./http-planning-types.js";
import { createHttpWireValuePlan } from "./http-wire-planner.js";
import { extractLiteralQuery } from "./uri-template.js";

export function createHttpWireOperationPlan(
  program: Program,
  operation: HttpOperation,
  operationId: string,
  serviceNamespace: import("@typespec/compiler").Namespace,
  api: HttpPlanningApi,
  serviceAuthentication?: Authentication,
): HttpWireOperationPlan {
  return {
    version: HTTP_OPERATION_PLAN_VERSION,
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
