import { executeHttpRequest } from "@typespex/http-client";
import { McpToolError } from "@typespex/mcp-server";
import type {
  HttpAuthCredentials,
  HttpBridgeBody,
  HttpBridgeMultipartPart,
  HttpBridgeOperation,
  HttpBridgeParameter,
  HttpWireValuePlan,
} from "./contracts.js";
import { asBodyBytes, asFileRecord, decodeBase64, isFileRecord } from "./binary.js";
import { upstreamRequestFailure } from "./errors.js";
import { assertSafeHeaderValue, setSafeHeader } from "./http-headers.js";
import { objectPairs, scalar } from "./http-serialization.js";
import {
  defaultContentType,
  extractMediaType,
  mediaTypeMatches,
  normalizeMediaType,
} from "./media-types.js";
import { getSourceValue, isRecord, setTargetValue } from "./value-paths.js";
import { encodeHttpWireValue } from "./wire-values.js";

export interface HttpBridgeRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body?: BodyInit;
  readonly cookies: CookiePair[];
}

export interface AppliedHttpCredentials {
  readonly queryNames: ReadonlySet<string>;
  readonly headerNames: ReadonlySet<string>;
}

export function createHttpBridgeRequest(
  baseUrl: URL,
  operation: HttpBridgeOperation,
  input: unknown,
): HttpBridgeRequest {
  const url = createOperationUrl(
    baseUrl,
    interpolatePath(operation.path, operation.parameters ?? [], input),
  );
  for (const parameter of operation.literalQuery ?? []) {
    url.searchParams.append(parameter.name, parameter.value);
  }

  const headers = new Headers({
    Accept: "application/json, application/jsonl, text/plain, */*",
  });
  const cookieValues: CookiePair[] = [];
  for (const parameter of operation.parameters ?? []) {
    if (parameter.location === "path") continue;
    const value = getSourceValue(input, parameter.source);
    if (value === undefined || value === null) {
      if (parameter.required) {
        throw new McpToolError(
          `Required HTTP ${parameter.location} parameter ${parameter.name} is missing.`,
        );
      }
      continue;
    }
    appendParameter(
      url,
      headers,
      cookieValues,
      parameter,
      parameter.value ? encodeHttpWireValue(value, parameter.value) : value,
    );
  }

  const body = operation.body ? createRequestBody(operation.body, input, headers) : undefined;
  return {
    url,
    method: operation.method.toUpperCase(),
    headers,
    ...(body === undefined ? {} : { body }),
    cookies: cookieValues,
  };
}

export function applyHttpCredentials(
  request: HttpBridgeRequest,
  credentials: HttpAuthCredentials | undefined,
): AppliedHttpCredentials {
  const queryNames = new Set<string>();
  const headerNames = new Set<string>();
  if (credentials) {
    for (const [name, value] of Object.entries(credentials.headers ?? {})) {
      setSafeHeader(request.headers, name, value);
      headerNames.add(name);
    }
    for (const [name, value] of Object.entries(credentials.query ?? {})) {
      request.url.searchParams.set(name, value);
      queryNames.add(name);
    }
    for (const [name, value] of Object.entries(credentials.cookies ?? {})) {
      for (let index = request.cookies.length - 1; index >= 0; index -= 1) {
        if (request.cookies[index]?.[0] === name) request.cookies.splice(index, 1);
      }
      request.cookies.push([name, value]);
    }
  }
  if (request.cookies.length > 0) {
    setSafeHeader(
      request.headers,
      "Cookie",
      request.cookies
        .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
        .join("; "),
    );
  }
  return { queryNames, headerNames };
}

function interpolatePath(
  path: string,
  parameters: readonly HttpBridgeParameter[],
  input: unknown,
): string {
  let output = path;
  for (const parameter of parameters) {
    if (parameter.location !== "path") continue;
    const value = getSourceValue(input, parameter.source);
    if (value === undefined || value === null) {
      if (!parameter.required) {
        output = output.replaceAll(`{${parameter.name}}`, "");
        continue;
      }
      throw new McpToolError(`Required HTTP path parameter ${parameter.name} is missing.`);
    }
    const encoded = serializePathValue(
      parameter,
      parameter.value ? encodeHttpWireValue(value, parameter.value) : value,
    );
    if (containsDotPathSegment(encoded)) {
      throw new McpToolError(
        `Rejected HTTP path parameter ${parameter.name} containing a dot path segment.`,
      );
    }
    output = output.replaceAll(`{${parameter.name}}`, encoded);
  }
  if (hasUnresolvedRouteParameter(output))
    throw new McpToolError(`Unresolved HTTP route parameter in ${output}.`);
  return output;
}

function hasUnresolvedRouteParameter(path: string): boolean {
  let opening = -1;
  for (let index = 0; index < path.length; index++) {
    const character = path[index];
    if (character === "{" && opening === -1) {
      opening = index;
    } else if (character === "}" && opening !== -1) {
      if (index > opening + 1) return true;
      opening = -1;
    }
  }
  return false;
}

function containsDotPathSegment(value: string): boolean {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // The URL constructor will preserve or reject malformed escapes. Raw dot
    // and backslash-delimited segments still need to be checked here.
  }
  return decoded
    .replaceAll("\\", "/")
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}

function createOperationUrl(baseUrl: URL, operationPath: string): URL {
  const url = new URL(baseUrl);
  const basePath = url.pathname === "/" ? "" : trimTrailingSlashes(url.pathname);
  const routePath = operationPath.startsWith("/") ? operationPath : `/${operationPath}`;
  url.pathname = `${basePath}${routePath}` || "/";
  url.hash = "";
  return url;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

function appendParameter(
  url: URL,
  headers: Headers,
  cookies: CookiePair[],
  parameter: HttpBridgeParameter,
  value: unknown,
): void {
  switch (parameter.location) {
    case "query":
      appendQueryParameter(url.searchParams, parameter, value);
      return;
    case "header":
      setSafeHeader(
        headers,
        parameter.name,
        serializeSimple(value, parameter.explode ?? false, false),
      );
      return;
    case "cookie":
      appendCookieParameter(cookies, parameter, value);
      return;
    case "path":
      return;
  }
}

type CookiePair = [name: string, value: string];

function appendCookieParameter(
  cookies: CookiePair[],
  parameter: HttpBridgeParameter,
  value: unknown,
): void {
  const explode = parameter.explode ?? true;
  if (Array.isArray(value)) {
    if (explode) {
      for (const item of value) cookies.push([parameter.name, scalar(item)]);
    } else {
      cookies.push([parameter.name, value.map(scalar).join(",")]);
    }
    return;
  }
  if (isRecord(value)) {
    if (explode) {
      for (const [name, item] of Object.entries(value)) cookies.push([name, scalar(item)]);
    } else {
      cookies.push([parameter.name, objectPairs(value).join(",")]);
    }
    return;
  }
  cookies.push([parameter.name, scalar(value)]);
}

function appendQueryParameter(
  search: URLSearchParams,
  parameter: HttpBridgeParameter,
  value: unknown,
): void {
  const style = parameter.style ?? "form";
  const explode = parameter.explode ?? style === "form";
  if (style === "deepObject") {
    if (!isRecord(value))
      throw new McpToolError(`deepObject parameter ${parameter.name} must be an object.`);
    for (const [key, item] of Object.entries(value))
      search.append(`${parameter.name}[${key}]`, scalar(item));
    return;
  }
  if (Array.isArray(value)) {
    if (style === "form" && explode) {
      for (const item of value) search.append(parameter.name, scalar(item));
      return;
    }
    const delimiter = style === "spaceDelimited" ? " " : style === "pipeDelimited" ? "|" : ",";
    search.append(parameter.name, value.map(scalar).join(delimiter));
    return;
  }
  if (isRecord(value)) {
    if (style === "form" && explode) {
      for (const [key, item] of Object.entries(value)) search.append(key, scalar(item));
      return;
    }
    search.append(parameter.name, objectPairs(value).join(","));
    return;
  }
  search.append(parameter.name, scalar(value));
}

function serializePathValue(parameter: HttpBridgeParameter, value: unknown): string {
  const style = parameter.style ?? "simple";
  const explode = parameter.explode ?? false;
  const encoded = serializeSimple(value, explode, !parameter.allowReserved);
  if (style === "label") return `.${encoded}`;
  if (style === "path") {
    const escape = (item: unknown) =>
      parameter.allowReserved ? scalar(item) : encodeURIComponent(scalar(item));
    if (Array.isArray(value)) {
      return `/${value.map(escape).join(explode ? "/" : ",")}`;
    }
    if (isRecord(value)) {
      const segments = Object.entries(value).flatMap(([key, item]) =>
        explode ? [`${escape(key)}=${escape(item)}`] : [escape(key), escape(item)],
      );
      return `/${segments.join(explode ? "/" : ",")}`;
    }
    return `/${escape(value)}`;
  }
  if (style === "matrix") {
    if (isRecord(value) && explode) {
      return Object.entries(value)
        .map(([key, item]) => `;${encodeURIComponent(key)}=${encodeURIComponent(scalar(item))}`)
        .join("");
    }
    return `;${encodeURIComponent(parameter.name)}=${encoded}`;
  }
  return encoded;
}

function serializeSimple(value: unknown, explode: boolean, encode: boolean): string {
  const escape = (item: unknown) => (encode ? encodeURIComponent(scalar(item)) : scalar(item));
  if (Array.isArray(value)) return value.map(escape).join(",");
  if (isRecord(value)) {
    return Object.entries(value)
      .flatMap(([key, item]) =>
        explode ? [`${escape(key)}=${escape(item)}`] : [escape(key), escape(item)],
      )
      .join(",");
  }
  return escape(value);
}

function createRequestBody(body: HttpBridgeBody, input: unknown, headers: Headers): BodyInit {
  const value = body.fields
    ? body.fields.reduce<unknown>(
        (output, field) => {
          const sourceValue = getSourceValue(input, field.source);
          return sourceValue === undefined
            ? output
            : setTargetValue(output, field.target, sourceValue);
        },
        typeof body.fields[0]?.target[0] === "number"
          ? []
          : (Object.create(null) as Record<string, unknown>),
      )
    : getSourceValue(input, body.source ?? []);
  const selected = resolveRequestMediaType(body, input);
  const contentType = selected.contentType;
  const kind = selected.kind;
  const valuePlan = selected.value ?? body.value;
  const transportValue = valuePlan ? encodeHttpWireValue(value, valuePlan) : value;
  if (kind !== "multipart") setSafeHeader(headers, "Content-Type", contentType);
  switch (kind) {
    case "json":
      return JSON.stringify(transportValue);
    case "text":
      return scalar(transportValue);
    case "binary":
      return asBodyBytes(decodeBase64(scalar(transportValue)));
    case "file": {
      const file = asFileRecord(transportValue);
      setSafeHeader(headers, "Content-Type", file.mediaType ?? contentType);
      return asBodyBytes(decodeBase64(file.data));
    }
    case "form": {
      if (!isRecord(transportValue)) {
        throw new McpToolError("Form request bodies must be objects.");
      }
      const form = new URLSearchParams();
      for (const [name, item] of Object.entries(transportValue)) {
        if (Array.isArray(item)) for (const entry of item) form.append(name, scalar(entry));
        else form.append(name, scalar(item));
      }
      return form;
    }
    case "multipart":
      return body.multipartParts
        ? createPlannedMultipartBody(body.multipartParts, input, contentType, headers)
        : createGenericMultipartBody(value);
    case "jsonl": {
      if (!Array.isArray(transportValue)) {
        throw new McpToolError("JSONL request bodies must be arrays.");
      }
      return (
        transportValue.map((item) => JSON.stringify(item)).join("\n") +
        (transportValue.length > 0 ? "\n" : "")
      );
    }
  }
}

function resolveRequestMediaType(
  body: HttpBridgeBody,
  input: unknown,
): {
  readonly kind: HttpBridgeBody["kind"];
  readonly contentType: string;
  readonly value?: HttpWireValuePlan;
} {
  const requested = body.contentTypeSource
    ? getSourceValue(input, body.contentTypeSource)
    : undefined;
  if (requested !== undefined && typeof requested !== "string") {
    throw new McpToolError("The HTTP request body requires a string Content-Type selector.");
  }
  const mediaTypes =
    body.mediaTypes ??
    (body.contentType
      ? [{ contentType: body.contentType, kind: body.kind }]
      : [{ contentType: defaultContentType(body.kind), kind: body.kind }]);
  if (typeof requested === "string") {
    const actual = normalizeMediaType(requested);
    const selected = mediaTypes.find((candidate) =>
      mediaTypeMatches(actual, candidate.contentType),
    );
    if (!selected) {
      throw new McpToolError(`Unsupported HTTP request Content-Type ${JSON.stringify(requested)}.`);
    }
    return { ...selected, contentType: requested };
  }
  return mediaTypes[0]!;
}

function createGenericMultipartBody(value: unknown): FormData {
  if (!isRecord(value)) throw new McpToolError("Multipart request bodies must be objects.");
  const form = new FormData();
  for (const [name, item] of Object.entries(value)) appendMultipart(form, name, item);
  return form;
}

function createPlannedMultipartBody(
  parts: readonly HttpBridgeMultipartPart[],
  input: unknown,
  contentType: string,
  headers: Headers,
): ArrayBuffer {
  const boundary = `typespex-${crypto.randomUUID().replaceAll("-", "")}`;
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    const value = getSourceValue(input, part.source);
    if (value === undefined || value === null) {
      if (part.optional) continue;
      throw new McpToolError(
        `Required multipart part ${JSON.stringify(part.name ?? part.source.join("."))} is missing.`,
      );
    }
    const values = part.multi ? requireMultipartArray(value, part) : [value];
    for (const item of values) appendMimePart(chunks, boundary, part, item);
  }
  chunks.push(new TextEncoder().encode(`--${boundary}--\r\n`));
  const mediaType = extractMediaType(contentType) ?? contentType.trim();
  setSafeHeader(headers, "Content-Type", `${mediaType}; boundary=${boundary}`);
  return asBodyBytes(concatenateBytes(chunks));
}

function requireMultipartArray(value: unknown, part: HttpBridgeMultipartPart): readonly unknown[] {
  if (Array.isArray(value)) return value;
  throw new McpToolError(
    `Repeated multipart part ${JSON.stringify(part.name ?? part.source.join("."))} must be an array.`,
  );
}

function appendMimePart(
  chunks: Uint8Array[],
  boundary: string,
  part: HttpBridgeMultipartPart,
  value: unknown,
): void {
  const encoded = encodeMultipartPart(part, value);
  assertSafeHeaderValue(encoded.contentType);
  const disposition = part.name
    ? `Content-Disposition: form-data; name="${escapeMimeToken(part.name)}"${encoded.fileName ? `; filename="${escapeMimeToken(encoded.fileName)}"` : ""}\r\n`
    : encoded.fileName
      ? `Content-Disposition: attachment; filename="${escapeMimeToken(encoded.fileName)}"\r\n`
      : "";
  chunks.push(
    new TextEncoder().encode(
      `--${boundary}\r\n${disposition}Content-Type: ${encoded.contentType}\r\n\r\n`,
    ),
    encoded.bytes,
    new TextEncoder().encode("\r\n"),
  );
}

function encodeMultipartPart(
  part: HttpBridgeMultipartPart,
  value: unknown,
): { readonly bytes: Uint8Array; readonly contentType: string; readonly fileName?: string } {
  const fallbackContentType = part.contentTypes[0] ?? defaultContentType(part.kind);
  const transportValue = part.value ? encodeHttpWireValue(value, part.value) : value;
  switch (part.kind) {
    case "file": {
      const file = asFileRecord(transportValue);
      return {
        bytes: decodeBase64(file.data),
        contentType: file.mediaType ?? fallbackContentType,
        fileName: file.name,
      };
    }
    case "binary":
      return { bytes: decodeBase64(scalar(transportValue)), contentType: fallbackContentType };
    case "text":
      return {
        bytes: new TextEncoder().encode(scalar(transportValue)),
        contentType: fallbackContentType,
      };
    case "json": {
      const json = JSON.stringify(transportValue);
      if (json === undefined) throw new McpToolError("Multipart JSON values must be serializable.");
      return { bytes: new TextEncoder().encode(json), contentType: fallbackContentType };
    }
  }
}

function escapeMimeToken(value: string): string {
  if (/\r|\n/.test(value)) throw new McpToolError("Rejected invalid multipart header value.");
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function concatenateBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function sendHttpBridgeRequest(
  fetchImplementation: typeof globalThis.fetch,
  initialUrl: URL,
  initial: { method: string; headers: Headers; body?: BodyInit },
  signal: AbortSignal,
  timeoutMs: number | undefined,
  maxRedirects: number,
  allowedOrigins: ReadonlySet<string>,
  credentialQueryNames: ReadonlySet<string>,
  credentialHeaderNames: ReadonlySet<string>,
): Promise<Response> {
  try {
    return await executeHttpRequest(
      initialUrl,
      { method: initial.method, headers: initial.headers, body: initial.body },
      {
        fetch: fetchImplementation,
        signal,
        headersTimeoutMs: timeoutMs,
        maxRedirects,
        allowedRedirectOrigins: [...allowedOrigins],
        sensitiveQueryParameters: [...credentialQueryNames],
        sensitiveHeaders: [
          "Authorization",
          "Proxy-Authorization",
          "Cookie",
          ...credentialHeaderNames,
        ],
      },
    );
  } catch (error) {
    throw upstreamRequestFailure(error);
  }
}

function appendMultipart(form: FormData, name: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) appendMultipart(form, name, item);
    return;
  }
  if (isFileRecord(value)) {
    const bytes = decodeBase64(value.data);
    form.append(
      name,
      new Blob([asBodyBytes(bytes)], { type: value.mediaType ?? "application/octet-stream" }),
      value.name,
    );
    return;
  }
  form.append(name, typeof value === "string" ? value : JSON.stringify(value));
}
