import {
  executeHttpRequest,
  HttpClientError,
  readBoundedBody,
  readBoundedJsonLines,
} from "@typespex/runtime/http-client";
import { ScalarEncodings } from "@typespex/runtime/scalar-encoding";
import type { McpToolContext, MaybePromise } from "./application.js";
import { McpToolError } from "./results.js";

export type HttpParameterLocation = "path" | "query" | "header" | "cookie";
export type HttpParameterStyle =
  | "simple"
  | "label"
  | "matrix"
  | "path"
  | "form"
  | "spaceDelimited"
  | "pipeDelimited"
  | "deepObject";

export interface HttpBridgeParameter {
  readonly source: readonly (string | number)[];
  readonly name: string;
  readonly location: HttpParameterLocation;
  readonly required?: boolean;
  readonly style?: HttpParameterStyle;
  readonly explode?: boolean;
  readonly allowReserved?: boolean;
  readonly value?: HttpWireValuePlan;
}

export interface HttpBridgeBody {
  readonly source?: readonly (string | number)[];
  readonly fields?: readonly {
    readonly source: readonly (string | number)[];
    readonly target: readonly (string | number)[];
  }[];
  readonly kind: "json" | "form" | "multipart" | "text" | "binary" | "file" | "jsonl";
  readonly contentType?: string;
  readonly contentTypeSource?: readonly (string | number)[];
  readonly mediaTypes?: readonly {
    readonly contentType: string;
    readonly kind: HttpBridgeBody["kind"];
    readonly value?: HttpWireValuePlan;
  }[];
  readonly multipartParts?: readonly HttpBridgeMultipartPart[];
  readonly value?: HttpWireValuePlan;
}

export interface HttpBridgeMultipartPart {
  readonly source: readonly (string | number)[];
  readonly name?: string;
  readonly multi: boolean;
  readonly optional: boolean;
  readonly kind: "json" | "text" | "binary" | "file";
  readonly contentTypes: readonly string[];
  readonly value?: HttpWireValuePlan;
}

export interface HttpBridgeResponseHeader {
  readonly name: string;
  readonly target: string | readonly (string | number)[];
  readonly collection?: boolean;
  readonly value?: HttpWireValuePlan;
}

export interface HttpBridgeResponse {
  readonly statuses: readonly (number | `${number}XX` | "default")[];
  readonly mediaTypes?: readonly string[];
  readonly kind?: "json" | "form" | "multipart" | "text" | "binary" | "file" | "jsonl" | "empty";
  readonly error?: boolean;
  readonly bodyValue?: HttpWireValuePlan;
  readonly multipartParts?: readonly HttpBridgeResponseMultipartPart[];
  readonly bodyTarget?: string | readonly (string | number)[];
  readonly statusTarget?: string | readonly (string | number)[];
  readonly contentTypeTarget?: string | readonly (string | number)[];
  readonly headers?: readonly HttpBridgeResponseHeader[];
}

export interface HttpBridgeResponseMultipartPart {
  readonly target: readonly (string | number)[];
  readonly name?: string;
  readonly multi: boolean;
  readonly optional: boolean;
  readonly kind: "json" | "text" | "binary" | "file";
  readonly contentTypes: readonly string[];
  readonly value?: HttpWireValuePlan;
}

export type HttpWireValuePlan =
  | { readonly kind: "identity" }
  | { readonly kind: "string" }
  | { readonly kind: "number"; readonly integer?: boolean }
  | { readonly kind: "boolean" }
  | { readonly kind: "null" }
  | {
      readonly kind: "scalar-encoding";
      readonly encoding:
        | "number-string"
        | "integer-string"
        | "boolean-string"
        | "rfc7231"
        | "unix-timestamp"
        | "duration-seconds"
        | "duration-milliseconds"
        | "base64url";
    }
  | {
      readonly kind: "file-json";
      readonly contentTypeSource?: string;
      readonly filenameSource?: string;
      readonly contentsSource: string;
      readonly textContents: boolean;
    }
  | { readonly kind: "literal"; readonly value: string | number | boolean | null }
  | { readonly kind: "array"; readonly item: HttpWireValuePlan }
  | { readonly kind: "tuple"; readonly items: readonly HttpWireValuePlan[] }
  | {
      readonly kind: "object";
      readonly properties: Readonly<
        Record<
          string,
          {
            readonly sourceName: string;
            readonly value: HttpWireValuePlan;
            readonly optional: boolean;
          }
        >
      >;
      readonly additional?: HttpWireValuePlan;
    }
  | { readonly kind: "union"; readonly variants: readonly HttpWireValuePlan[] };

export type HttpAuthScheme =
  | {
      readonly id: string;
      readonly type: "apiKey";
      readonly location: "header" | "query" | "cookie";
      readonly name: string;
    }
  | {
      readonly id: string;
      readonly type: "http";
      readonly scheme: string;
    }
  | { readonly id: string; readonly type: "oauth2" | "openIdConnect" };

export type HttpAuthAlternative =
  | { readonly noAuth: true }
  | { readonly noAuth?: false; readonly schemes: readonly HttpAuthScheme[] };

export interface HttpBridgeServer {
  readonly url: string;
  readonly fullyDefaulted?: boolean;
}

export interface HttpBridgeOperation {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly literalQuery?: readonly { readonly name: string; readonly value: string }[];
  readonly parameters?: readonly HttpBridgeParameter[];
  readonly body?: HttpBridgeBody;
  readonly responses: readonly HttpBridgeResponse[];
  readonly servers?: readonly HttpBridgeServer[];
  readonly auth?: readonly HttpAuthAlternative[];
}

export interface HttpAuthCredentials {
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly cookies?: Readonly<Record<string, string>>;
}

export interface HttpAuthProviderRequest {
  readonly operation: HttpBridgeOperation;
  readonly alternatives: readonly HttpAuthAlternative[];
  readonly input: unknown;
  readonly context: McpToolContext;
}

export type McpHttpAuthProvider = (
  request: HttpAuthProviderRequest,
) => MaybePromise<HttpAuthCredentials | undefined>;

export interface HttpServerResolverRequest {
  readonly operation: HttpBridgeOperation;
  readonly input: unknown;
  readonly context: McpToolContext;
}

export interface McpHttpBridgeOptions {
  readonly server?: string | URL;
  readonly resolveServer?: (
    request: HttpServerResolverRequest,
  ) => MaybePromise<string | URL | undefined>;
  readonly authProvider?: McpHttpAuthProvider;
  readonly fetch?: typeof globalThis.fetch;
  /** Origins to which an operation may resolve or redirect. */
  readonly allowedUpstreamOrigins?: readonly string[];
  /** Redirect count. Zero disables redirects. Defaults to 3. */
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
  readonly maxJsonlItems?: number;
  readonly maxResponseBytes?: number;
  readonly maxDiagnosticBytes?: number;
  /** Explicitly exposes bounded upstream diagnostic bodies in MCP operational errors. */
  readonly exposeUpstreamDiagnostics?: boolean;
}

export interface HttpBridgeResult {
  readonly kind: "success" | "error";
  readonly value: unknown;
  readonly status: number;
}

const DEFAULT_MAX_JSONL_ITEMS = 1_000;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_DIAGNOSTIC_BYTES = 64 * 1024;

/** Executes a generated HTTP wire plan. Input and output are JSON-wire values. */
export async function executeHttpBridgeTool(
  operation: HttpBridgeOperation,
  input: unknown,
  context: McpToolContext,
  options: McpHttpBridgeOptions,
): Promise<HttpBridgeResult> {
  const baseUrl = await resolveServer(operation, input, context, options);
  const allowedOrigins = normalizeOrigins(options.allowedUpstreamOrigins);
  if (allowedOrigins.size > 0 && !allowedOrigins.has(baseUrl.origin)) {
    throw new McpToolError(`Resolved upstream origin ${baseUrl.origin} is not allowed.`);
  }

  const url = createOperationUrl(
    baseUrl,
    interpolatePath(operation.path, operation.parameters ?? [], input),
  );
  for (const parameter of operation.literalQuery ?? []) {
    url.searchParams.append(parameter.name, parameter.value);
  }
  const headers = new Headers({ Accept: "application/json, application/jsonl, text/plain, */*" });
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

  const auth = await resolveCredentials(operation, input, context, options.authProvider);
  const credentialQueryNames = new Set<string>();
  if (auth) {
    for (const [name, value] of Object.entries(auth.headers ?? {}))
      setSafeHeader(headers, name, value);
    for (const [name, value] of Object.entries(auth.query ?? {})) {
      url.searchParams.set(name, value);
      credentialQueryNames.add(name);
    }
    for (const [name, value] of Object.entries(auth.cookies ?? {})) {
      for (let index = cookieValues.length - 1; index >= 0; index -= 1) {
        if (cookieValues[index]?.[0] === name) cookieValues.splice(index, 1);
      }
      cookieValues.push([name, value]);
    }
  }
  if (cookieValues.length > 0) {
    headers.set(
      "Cookie",
      cookieValues
        .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
        .join("; "),
    );
  }

  const body = operation.body ? createRequestBody(operation.body, input, headers) : undefined;
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new McpToolError("No Fetch implementation is available for the HTTP bridge.");
  }
  const maxRedirects = boundedInteger(options.maxRedirects ?? 3, "maxRedirects", 0);
  const method = operation.method.toUpperCase();
  const response = await fetchWithRedirectPolicy(
    fetchImplementation,
    url,
    { method, headers, body },
    context.signal,
    options.timeoutMs,
    maxRedirects,
    allowedOrigins,
    credentialQueryNames,
  );

  const descriptor = selectResponse(
    operation.responses,
    response.status,
    response.headers.get("content-type"),
  );
  if (!descriptor) {
    const diagnostic = options.exposeUpstreamDiagnostics
      ? await readDiagnostic(response, options.maxDiagnosticBytes, context.signal)
      : "";
    if (!options.exposeUpstreamDiagnostics) await cancelResponseBody(response);
    throw new McpToolError(
      `Upstream returned undeclared HTTP ${response.status}${diagnostic ? `: ${diagnostic}` : "."}`,
    );
  }
  const decoded = await decodeResponse(response, descriptor, options, context.signal);
  if (descriptor.error) return { kind: "error", value: decoded, status: response.status };
  return { kind: "success", value: decoded, status: response.status };
}

export function composeHttpAuthProviders(
  ...providers: readonly McpHttpAuthProvider[]
): McpHttpAuthProvider {
  return async (request) => {
    for (const provider of providers) {
      const credentials = await provider(request);
      if (credentials) return credentials;
    }
    return undefined;
  };
}

export type StaticHttpCredential = string | { readonly value: string; readonly prefix?: string };

/** Creates a provider keyed by generated TypeSpec auth scheme IDs. */
export function staticHttpAuthProvider(
  credentials: Readonly<Record<string, StaticHttpCredential | undefined>>,
): McpHttpAuthProvider {
  return ({ alternatives }) => {
    let permitsNoAuth = false;
    for (const alternative of alternatives) {
      if (alternative.noAuth) {
        permitsNoAuth = true;
        continue;
      }
      const output: MutableCredentials = { headers: {}, query: {}, cookies: {} };
      let complete = true;
      for (const scheme of alternative.schemes) {
        const configured = Object.hasOwn(credentials, scheme.id)
          ? credentials[scheme.id]
          : undefined;
        if (!configured) {
          complete = false;
          break;
        }
        applyStaticCredential(output, scheme, configured);
      }
      if (complete) return compactCredentials(output);
    }
    return permitsNoAuth ? {} : undefined;
  };
}

export function environmentHttpAuthProvider(
  variables: Readonly<Record<string, string>>,
  environment: Readonly<Record<string, string | undefined>> = runtimeEnvironment(),
): McpHttpAuthProvider {
  const credentials: Record<string, string | undefined> = {};
  for (const [scheme, variable] of Object.entries(variables))
    credentials[scheme] = environment[variable];
  return staticHttpAuthProvider(credentials);
}

/** Explicit opt-in to forwarding a verified inbound bearer token upstream. */
export function forwardInboundBearerAuthProvider(): McpHttpAuthProvider {
  return ({ alternatives, context }) => {
    if (!context.authInfo?.token) return undefined;
    const acceptsBearer = alternatives.some(
      (alternative) =>
        !alternative.noAuth &&
        alternative.schemes.length === 1 &&
        (alternative.schemes[0]?.type === "oauth2" ||
          alternative.schemes[0]?.type === "openIdConnect" ||
          (alternative.schemes[0]?.type === "http" &&
            alternative.schemes[0].scheme.toLowerCase() === "bearer")),
    );
    return acceptsBearer
      ? { headers: { Authorization: `Bearer ${context.authInfo.token}` } }
      : undefined;
  };
}

async function resolveServer(
  operation: HttpBridgeOperation,
  input: unknown,
  context: McpToolContext,
  options: McpHttpBridgeOptions,
): Promise<URL> {
  if (options.server !== undefined && options.resolveServer !== undefined) {
    throw new McpToolError("Configure either bridge.server or bridge.resolveServer, not both.");
  }
  let resolved: string | URL | undefined = options.server;
  if (!resolved && options.resolveServer) {
    if (!options.allowedUpstreamOrigins?.length) {
      throw new McpToolError("Dynamic upstream server resolution requires allowedUpstreamOrigins.");
    }
    resolved = await options.resolveServer({ operation, input, context });
  }
  resolved ??=
    operation.servers?.length === 1 && operation.servers[0]?.fullyDefaulted
      ? operation.servers[0].url
      : undefined;
  if (!resolved) {
    throw new McpToolError(
      `No upstream server is resolvable for ${operation.id}; configure bridge.server or bridge.resolveServer.`,
    );
  }
  const url = resolved instanceof URL ? new URL(resolved) : new URL(resolved);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new McpToolError(`Unsupported upstream URL scheme ${url.protocol}.`);
  }
  if (url.username || url.password)
    throw new McpToolError("Upstream URLs must not contain credentials.");
  return url;
}

async function resolveCredentials(
  operation: HttpBridgeOperation,
  input: unknown,
  context: McpToolContext,
  provider: McpHttpAuthProvider | undefined,
): Promise<HttpAuthCredentials | undefined> {
  const alternatives = operation.auth ?? [];
  if (alternatives.length === 0) return undefined;
  const noAuth = alternatives.some((alternative) => alternative.noAuth);
  if (!provider) {
    if (noAuth) return undefined;
    throw new McpToolError(`Upstream authentication is required for ${operation.id}.`);
  }
  const credentials = await provider({ operation, alternatives, input, context });
  if ((!credentials || !hasCredentialValue(credentials)) && !noAuth) {
    throw new McpToolError(`No usable upstream credential is available for ${operation.id}.`);
  }
  return credentials;
}

function hasCredentialValue(credentials: HttpAuthCredentials): boolean {
  return [credentials.headers, credentials.query, credentials.cookies].some(
    (values) => values && Object.keys(values).length > 0,
  );
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
  if (/\{[^}]+\}/.test(output))
    throw new McpToolError(`Unresolved HTTP route parameter in ${output}.`);
  return output;
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
  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  const routePath = operationPath.startsWith("/") ? operationPath : `/${operationPath}`;
  url.pathname = `${basePath}${routePath}` || "/";
  url.hash = "";
  return url;
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
  if (kind !== "multipart") headers.set("Content-Type", contentType);
  switch (kind) {
    case "json":
      return JSON.stringify(transportValue);
    case "text":
      return scalar(transportValue);
    case "binary":
      return asBodyBytes(decodeBase64(scalar(transportValue)));
    case "file": {
      const file = asFileRecord(transportValue);
      headers.set("Content-Type", file.mediaType ?? contentType);
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
  if (body.contentTypeSource && typeof requested !== "string") {
    throw new McpToolError("The HTTP request body requires a string Content-Type selector.");
  }
  const mediaTypes =
    body.mediaTypes ??
    (body.contentType
      ? [{ contentType: body.contentType, kind: body.kind }]
      : [{ contentType: defaultContentType(body.kind), kind: body.kind }]);
  if (typeof requested === "string") {
    const actual = requested.split(";", 1)[0]!.trim().toLowerCase();
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
  const mediaType = contentType.split(";", 1)[0]!.trim();
  headers.set("Content-Type", `${mediaType}; boundary=${boundary}`);
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

async function fetchWithRedirectPolicy(
  fetchImplementation: typeof globalThis.fetch,
  initialUrl: URL,
  initial: { method: string; headers: Headers; body?: BodyInit },
  signal: AbortSignal,
  timeoutMs: number | undefined,
  maxRedirects: number,
  allowedOrigins: ReadonlySet<string>,
  credentialQueryNames: ReadonlySet<string>,
): Promise<Response> {
  try {
    return await executeHttpRequest(
      initialUrl,
      { method: initial.method, headers: initial.headers, body: initial.body },
      {
        fetch: fetchImplementation,
        signal,
        timeoutMs,
        maxRedirects,
        allowedRedirectOrigins: [...allowedOrigins],
        sensitiveQueryParameters: [...credentialQueryNames],
      },
    );
  } catch (error) {
    throw httpClientFailure(error);
  }
}

async function decodeResponse(
  response: Response,
  descriptor: HttpBridgeResponse,
  options: McpHttpBridgeOptions,
  signal: AbortSignal,
): Promise<unknown> {
  const kind = descriptor.kind ?? inferResponseKind(response.headers.get("content-type"));
  const maxBytes = boundedInteger(
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    "maxResponseBytes",
    1,
  );
  let body: unknown;
  switch (kind) {
    case "empty":
      await cancelResponseBody(response);
      body = undefined;
      break;
    case "jsonl":
      body = await readJsonl(
        response,
        boundedInteger(options.maxJsonlItems ?? DEFAULT_MAX_JSONL_ITEMS, "maxJsonlItems", 1),
        maxBytes,
        signal,
      );
      break;
    case "json": {
      const bytes = await readLimitedBytes(response, maxBytes, signal);
      if (bytes.length === 0) body = undefined;
      else {
        try {
          body = JSON.parse(new TextDecoder().decode(bytes));
        } catch (error) {
          throw new McpToolError("Upstream returned invalid JSON.", { cause: error });
        }
      }
      break;
    }
    case "form": {
      const text = new TextDecoder().decode(await readLimitedBytes(response, maxBytes, signal));
      const values = new URLSearchParams(text);
      const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [name, value] of values) {
        const existing = output[name];
        output[name] =
          existing === undefined
            ? value
            : Array.isArray(existing)
              ? [...existing, value]
              : [existing, value];
      }
      body = output;
      break;
    }
    case "multipart": {
      const bytes = await readLimitedBytes(response, maxBytes, signal);
      const contentType = response.headers.get("content-type") ?? "multipart/form-data";
      if (descriptor.multipartParts) {
        body = decodePlannedMultipartBody(bytes, contentType, descriptor.multipartParts);
      } else {
        const parsed = await new Response(asBodyBytes(bytes), {
          headers: { "Content-Type": contentType },
        }).formData();
        const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        for (const [name, value] of parsed) {
          const wireValue = typeof value === "string" ? value : await fileToRecord(value);
          const existing = output[name];
          output[name] =
            existing === undefined
              ? wireValue
              : Array.isArray(existing)
                ? [...existing, wireValue]
                : [existing, wireValue];
        }
        body = output;
      }
      break;
    }
    case "text":
      body = new TextDecoder().decode(await readLimitedBytes(response, maxBytes, signal));
      break;
    case "binary":
      body = encodeBase64(await readLimitedBytes(response, maxBytes, signal));
      break;
    case "file": {
      const bytes = await readLimitedBytes(response, maxBytes, signal);
      body = {
        name: responseFileName(response.headers.get("content-disposition")) ?? "response.bin",
        ...(response.headers.get("content-type")
          ? { mediaType: response.headers.get("content-type")!.split(";", 1)[0]!.trim() }
          : {}),
        data: encodeBase64(bytes),
      };
      break;
    }
  }
  if (descriptor.bodyValue) body = decodeHttpWireValue(body, descriptor.bodyValue);

  if (
    !descriptor.bodyTarget &&
    !descriptor.statusTarget &&
    !descriptor.contentTypeTarget &&
    !descriptor.headers?.length
  ) {
    return body;
  }
  let output: unknown =
    !descriptor.bodyTarget && isRecord(body) ? { ...body } : Object.create(null);
  if (descriptor.bodyTarget) output = setTargetValue(output, descriptor.bodyTarget, body);
  if (descriptor.statusTarget) {
    output = setTargetValue(output, descriptor.statusTarget, response.status);
  }
  if (descriptor.contentTypeTarget) {
    output = setTargetValue(
      output,
      descriptor.contentTypeTarget,
      response.headers.get("content-type")?.split(";", 1)[0]?.trim(),
    );
  }
  for (const header of descriptor.headers ?? []) {
    const value = response.headers.get(header.name);
    if (value !== null) {
      const wireValue = header.collection ? splitHttpList(value) : value;
      output = setTargetValue(
        output,
        header.target,
        header.value ? decodeHttpWireValue(wireValue, header.value) : wireValue,
      );
    }
  }
  return output;
}

async function readJsonl(
  response: Response,
  maxItems: number,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown[]> {
  try {
    return await readBoundedJsonLines(
      response,
      { maximumItems: maxItems, maximumBytes: maxBytes },
      signal,
    );
  } catch (error) {
    throw httpClientFailure(error);
  }
}

interface ParsedMimePart {
  readonly headers: Headers;
  readonly body: Uint8Array;
  readonly name?: string;
  readonly fileName?: string;
}

function decodePlannedMultipartBody(
  bytes: Uint8Array,
  contentType: string,
  descriptors: readonly HttpBridgeResponseMultipartPart[],
): unknown {
  const parsed = parseMultipartBytes(bytes, contentType);
  const values = new Map<HttpBridgeResponseMultipartPart, unknown[]>();
  const unnamed = descriptors.filter((descriptor) => !descriptor.name);
  let unnamedIndex = 0;
  for (let index = 0; index < parsed.length; index += 1) {
    const part = parsed[index]!;
    let descriptor = part.name
      ? descriptors.find((candidate) => candidate.name === part.name)
      : undefined;
    if (!descriptor) {
      while (unnamedIndex < unnamed.length) {
        const candidate = unnamed[unnamedIndex]!;
        if (!candidate.multi) {
          descriptor = candidate;
          unnamedIndex += 1;
          break;
        }
        const remainingParts = parsed.length - index;
        const requiredAfter = unnamed
          .slice(unnamedIndex + 1)
          .filter((item) => !item.optional && !item.multi).length;
        if (remainingParts <= requiredAfter) {
          unnamedIndex += 1;
          continue;
        }
        descriptor = candidate;
        break;
      }
    }
    if (!descriptor) throw new McpToolError("Upstream returned an undeclared multipart part.");
    const actualContentType = part.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (
      descriptor.contentTypes.length > 0 &&
      (!actualContentType ||
        !descriptor.contentTypes.some((declared) =>
          mediaTypeMatches(actualContentType.toLowerCase(), declared),
        ))
    ) {
      throw new McpToolError(
        `Upstream multipart part ${JSON.stringify(descriptor.name ?? descriptor.target.join("."))} has an undeclared Content-Type.`,
      );
    }
    const decoded = decodeMultipartPart(part, descriptor);
    const existing = values.get(descriptor) ?? [];
    existing.push(decoded);
    values.set(descriptor, existing);
  }

  let output: unknown = typeof descriptors[0]?.target[0] === "number" ? [] : Object.create(null);
  for (const descriptor of descriptors) {
    const matches = values.get(descriptor) ?? [];
    if (!descriptor.multi && matches.length > 1) {
      throw new McpToolError(
        `Upstream returned multipart part ${JSON.stringify(descriptor.name)} more than once.`,
      );
    }
    if (matches.length === 0) {
      if (descriptor.multi && !descriptor.optional) {
        output = setTargetValue(output, descriptor.target, []);
      } else if (!descriptor.optional) {
        throw new McpToolError(
          `Upstream omitted required multipart part ${JSON.stringify(descriptor.name ?? descriptor.target.join("."))}.`,
        );
      }
      continue;
    }
    output = setTargetValue(output, descriptor.target, descriptor.multi ? matches : matches[0]);
  }
  return output;
}

function decodeMultipartPart(
  part: ParsedMimePart,
  descriptor: HttpBridgeResponseMultipartPart,
): unknown {
  const contentType = part.headers.get("content-type")?.split(";", 1)[0]?.trim();
  let value: unknown;
  switch (descriptor.kind) {
    case "file":
      value = {
        name: part.fileName ?? "file",
        ...(contentType ? { mediaType: contentType } : {}),
        data: encodeBase64(part.body),
      };
      break;
    case "binary":
      value = encodeBase64(part.body);
      break;
    case "text":
      value = new TextDecoder().decode(part.body);
      break;
    case "json":
      try {
        value = JSON.parse(new TextDecoder().decode(part.body));
      } catch (error) {
        throw new McpToolError("Upstream returned invalid JSON in a multipart part.", {
          cause: error,
        });
      }
      break;
  }
  return descriptor.value ? decodeHttpWireValue(value, descriptor.value) : value;
}

function parseMultipartBytes(bytes: Uint8Array, contentType: string): ParsedMimePart[] {
  const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) {
    throw new McpToolError("Upstream multipart response has an invalid boundary.");
  }
  const delimiter = new TextEncoder().encode(`--${boundary}`);
  const headerSeparator = new Uint8Array([13, 10, 13, 10]);
  const nextPrefix = new TextEncoder().encode(`\r\n--${boundary}`);
  const delimiterMatcher = createByteMatcher(delimiter);
  const headerSeparatorMatcher = createByteMatcher(headerSeparator);
  const nextPrefixMatcher = createByteMatcher(nextPrefix);
  const output: ParsedMimePart[] = [];
  let cursor = delimiterMatcher.find(bytes, 0);
  if (cursor < 0) throw new McpToolError("Upstream multipart boundary was not found.");
  while (cursor >= 0) {
    cursor += delimiter.length;
    if (bytes[cursor] === 45 && bytes[cursor + 1] === 45) break;
    if (bytes[cursor] !== 13 || bytes[cursor + 1] !== 10) {
      throw new McpToolError("Upstream multipart framing is invalid.");
    }
    cursor += 2;
    const headersEnd = headerSeparatorMatcher.find(bytes, cursor);
    if (headersEnd < 0) throw new McpToolError("Upstream multipart headers are incomplete.");
    const headers = parseMimeHeaders(bytes.subarray(cursor, headersEnd));
    const bodyStart = headersEnd + headerSeparator.length;
    const next = nextPrefixMatcher.find(bytes, bodyStart);
    if (next < 0) throw new McpToolError("Upstream multipart closing boundary is missing.");
    const disposition = headers.get("content-disposition");
    output.push({
      headers,
      body: bytes.slice(bodyStart, next),
      ...(mimeDispositionParameter(disposition, "name")
        ? { name: mimeDispositionParameter(disposition, "name") }
        : {}),
      ...(responseFileName(disposition) ? { fileName: responseFileName(disposition) } : {}),
    });
    cursor = next + 2;
  }
  return output;
}

function parseMimeHeaders(bytes: Uint8Array): Headers {
  const headers = new Headers();
  for (const line of new TextDecoder().decode(bytes).split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new McpToolError("Upstream multipart header is malformed.");
    setSafeHeader(headers, line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return headers;
}

function mimeDispositionParameter(
  disposition: string | null,
  parameter: string,
): string | undefined {
  if (!disposition) return undefined;
  const match = new RegExp(`(?:^|;)\\s*${parameter}=(?:"((?:\\\\.|[^"])*)"|([^;\\s]+))`, "i").exec(
    disposition,
  );
  const value = match?.[1]?.replaceAll(/\\(.)/g, "$1") ?? match?.[2];
  return value || undefined;
}

function createByteMatcher(needle: Uint8Array): {
  find(haystack: Uint8Array, start: number): number;
} {
  const fallback = new Uint32Array(needle.length);
  for (let index = 1, matched = 0; index < needle.length; index += 1) {
    while (matched > 0 && needle[index] !== needle[matched]) matched = fallback[matched - 1]!;
    if (needle[index] === needle[matched]) matched += 1;
    fallback[index] = matched;
  }
  return {
    find(haystack, start) {
      if (needle.length === 0) return Math.min(Math.max(start, 0), haystack.length);
      let matched = 0;
      for (let index = Math.max(start, 0); index < haystack.length; index += 1) {
        while (matched > 0 && haystack[index] !== needle[matched]) {
          matched = fallback[matched - 1]!;
        }
        if (haystack[index] === needle[matched]) matched += 1;
        if (matched === needle.length) return index - needle.length + 1;
      }
      return -1;
    },
  };
}

async function readLimitedBytes(
  response: Response,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  try {
    return await readBoundedBody(response, maximum, signal);
  } catch (error) {
    throw httpClientFailure(error);
  }
}

function selectResponse(
  responses: readonly HttpBridgeResponse[],
  status: number,
  contentType: string | null,
): HttpBridgeResponse | undefined {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return responses
    .flatMap((response) => {
      const statusScore = Math.max(
        ...response.statuses.map((declared) =>
          declared === "default"
            ? 1
            : typeof declared === "number"
              ? declared === status
                ? 3
                : -1
              : Number(declared[0]) === Math.floor(status / 100)
                ? 2
                : -1,
        ),
      );
      if (statusScore < 0) return [];
      const mediaScore = !response.mediaTypes?.length
        ? mediaType === undefined || response.kind === "empty"
          ? 2
          : 0
        : Math.max(
            ...response.mediaTypes.map((declared) =>
              mediaTypeMatches(mediaType, declared)
                ? declared.split(";", 1)[0]!.trim() === mediaType
                  ? 2
                  : 1
                : -1,
            ),
          );
      return mediaScore < 0 ? [] : [{ response, score: statusScore * 10 + mediaScore }];
    })
    .sort((left, right) => right.score - left.score)[0]?.response;
}

function mediaTypeMatches(actual: string | undefined, declared: string): boolean {
  if (!actual) return false;
  const expected = declared.split(";", 1)[0]!.trim().toLowerCase();
  if (expected === "*/*" || expected === actual) return true;
  const [expectedType, expectedSubtype] = expected.split("/");
  const [actualType, actualSubtype] = actual.split("/");
  const subtypeMatches =
    expectedSubtype === "*" ||
    expectedSubtype === actualSubtype ||
    (expectedSubtype?.startsWith("*+") && actualSubtype?.endsWith(expectedSubtype.slice(1)));
  return (expectedType === "*" || expectedType === actualType) && subtypeMatches;
}

async function readDiagnostic(
  response: Response,
  maximum = DEFAULT_MAX_DIAGNOSTIC_BYTES,
  signal: AbortSignal,
): Promise<string> {
  const cap = boundedInteger(maximum, "maxDiagnosticBytes", 1);
  if (!response.body) return "";
  let bytes: Uint8Array;
  try {
    bytes = await readLimitedBytes(response, cap, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    bytes = new Uint8Array();
  }
  return new TextDecoder().decode(bytes).replaceAll(/\s+/g, " ").trim();
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup must not replace the declared MCP result or operational error.
  }
}

function inferResponseKind(contentType: string | null): NonNullable<HttpBridgeResponse["kind"]> {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mediaType === "application/jsonl" || mediaType === "application/x-ndjson") return "jsonl";
  if (mediaType === "application/json" || mediaType.endsWith("+json")) return "json";
  if (mediaType === "application/x-www-form-urlencoded") return "form";
  if (mediaType.startsWith("multipart/")) return "multipart";
  if (mediaType.startsWith("text/")) return "text";
  return "binary";
}

function defaultContentType(kind: HttpBridgeBody["kind"]): string {
  switch (kind) {
    case "json":
      return "application/json";
    case "form":
      return "application/x-www-form-urlencoded";
    case "multipart":
      return "multipart/form-data";
    case "text":
      return "text/plain; charset=utf-8";
    case "jsonl":
      return "application/jsonl";
    case "binary":
    case "file":
      return "application/octet-stream";
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

function decodeHttpWireValue(value: unknown, plan: HttpWireValuePlan): unknown {
  switch (plan.kind) {
    case "identity":
      return value;
    case "string":
      if (typeof value === "string") return value;
      throw new McpToolError("Upstream returned a non-string HTTP value.");
    case "number": {
      const number =
        typeof value === "number"
          ? value
          : typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)
            ? Number(value)
            : Number.NaN;
      if (!Number.isFinite(number) || (plan.integer && !Number.isSafeInteger(number))) {
        throw new McpToolError(
          `Upstream returned an invalid HTTP ${plan.integer ? "integer" : "number"}.`,
        );
      }
      return number;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      if (value === "true") return true;
      if (value === "false") return false;
      throw new McpToolError("Upstream returned an invalid HTTP boolean.");
    case "null":
      if (value === null) return null;
      throw new McpToolError("Upstream returned a non-null HTTP value.");
    case "scalar-encoding":
      return decodeHttpScalarEncoding(value, plan.encoding);
    case "literal": {
      const converted = decodeHttpWireValue(value, literalValuePlan(plan.value));
      if (Object.is(converted, plan.value)) return converted;
      throw new McpToolError("Upstream returned an unexpected HTTP literal value.");
    }
    case "array": {
      const values = Array.isArray(value) ? value : [value];
      return values.map((item) => decodeHttpWireValue(item, plan.item));
    }
    case "tuple":
      if (!Array.isArray(value) || value.length !== plan.items.length) {
        throw new McpToolError(`Upstream returned an HTTP tuple with the wrong length.`);
      }
      return plan.items.map((item, index) => decodeHttpWireValue(value[index], item));
    case "object": {
      if (!isRecord(value)) throw new McpToolError("Upstream returned a non-object HTTP value.");
      const output: Record<string, unknown> = Object.create(null);
      const known = new Set<string>();
      for (const [targetName, property] of Object.entries(plan.properties)) {
        known.add(property.sourceName);
        if (!Object.hasOwn(value, property.sourceName)) {
          if (!property.optional) {
            throw new McpToolError(
              `Upstream HTTP object is missing ${JSON.stringify(property.sourceName)}.`,
            );
          }
          continue;
        }
        output[targetName] = decodeHttpWireValue(value[property.sourceName], property.value);
      }
      if (plan.additional) {
        for (const [name, item] of Object.entries(value)) {
          if (!known.has(name)) output[name] = decodeHttpWireValue(item, plan.additional);
        }
      }
      return output;
    }
    case "union": {
      for (const variant of plan.variants) {
        try {
          return decodeHttpWireValue(value, variant);
        } catch (error) {
          if (!(error instanceof McpToolError)) throw error;
        }
      }
      throw new McpToolError("Upstream returned a value outside the declared HTTP union.");
    }
    case "file-json": {
      if (!isRecord(value)) throw new McpToolError("Upstream returned a non-object JSON file.");
      const contents = value[plan.contentsSource];
      if (typeof contents !== "string") {
        throw new McpToolError("Upstream JSON file is missing string contents.");
      }
      const filename = plan.filenameSource ? value[plan.filenameSource] : undefined;
      const mediaType = plan.contentTypeSource ? value[plan.contentTypeSource] : undefined;
      if (filename !== undefined && typeof filename !== "string") {
        throw new McpToolError("Upstream JSON file has an invalid filename.");
      }
      if (mediaType !== undefined && typeof mediaType !== "string") {
        throw new McpToolError("Upstream JSON file has an invalid content type.");
      }
      return {
        name: filename || "file",
        ...(mediaType ? { mediaType } : {}),
        data: plan.textContents ? encodeBase64(new TextEncoder().encode(contents)) : contents,
      };
    }
  }
}

function encodeHttpWireValue(value: unknown, plan: HttpWireValuePlan): unknown {
  switch (plan.kind) {
    case "identity":
      return value;
    case "string":
      if (typeof value === "string") return value;
      throw new McpToolError("Expected a string HTTP request value.");
    case "number":
      if (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (!plan.integer || Number.isSafeInteger(value))
      ) {
        return value;
      }
      throw new McpToolError(`Expected an HTTP request ${plan.integer ? "integer" : "number"}.`);
    case "boolean":
      if (typeof value === "boolean") return value;
      throw new McpToolError("Expected a boolean HTTP request value.");
    case "null":
      if (value === null) return null;
      throw new McpToolError("Expected a null HTTP request value.");
    case "scalar-encoding":
      return encodeHttpScalarEncoding(value, plan.encoding);
    case "literal":
      if (Object.is(value, plan.value)) return value;
      throw new McpToolError("Expected the declared HTTP request literal.");
    case "array":
      if (!Array.isArray(value)) throw new McpToolError("Expected an HTTP request array.");
      return value.map((item) => encodeHttpWireValue(item, plan.item));
    case "tuple":
      if (!Array.isArray(value) || value.length !== plan.items.length) {
        throw new McpToolError("Expected an HTTP request tuple with the declared length.");
      }
      return plan.items.map((item, index) => encodeHttpWireValue(value[index], item));
    case "object": {
      if (!isRecord(value)) throw new McpToolError("Expected an HTTP request object.");
      const output: Record<string, unknown> = Object.create(null);
      const known = new Set<string>();
      for (const [targetName, property] of Object.entries(plan.properties)) {
        known.add(targetName);
        if (!Object.hasOwn(value, targetName)) {
          if (!property.optional) {
            throw new McpToolError(`HTTP request object is missing ${JSON.stringify(targetName)}.`);
          }
          continue;
        }
        output[property.sourceName] = encodeHttpWireValue(value[targetName], property.value);
      }
      if (plan.additional) {
        for (const [name, item] of Object.entries(value)) {
          if (!known.has(name)) output[name] = encodeHttpWireValue(item, plan.additional);
        }
      }
      return output;
    }
    case "union":
      for (const variant of plan.variants) {
        try {
          return encodeHttpWireValue(value, variant);
        } catch (error) {
          if (!(error instanceof McpToolError)) throw error;
        }
      }
      throw new McpToolError("HTTP request value is outside the declared union.");
    case "file-json": {
      const file = asFileRecord(value);
      const output: Record<string, unknown> = Object.create(null);
      if (plan.contentTypeSource && file.mediaType) {
        output[plan.contentTypeSource] = file.mediaType;
      }
      if (plan.filenameSource) output[plan.filenameSource] = file.name;
      output[plan.contentsSource] = plan.textContents
        ? new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64(file.data))
        : file.data;
      return output;
    }
  }
}

function literalValuePlan(value: string | number | boolean | null): HttpWireValuePlan {
  return value === null
    ? { kind: "null" }
    : typeof value === "string"
      ? { kind: "string" }
      : typeof value === "number"
        ? { kind: "number", integer: Number.isInteger(value) }
        : { kind: "boolean" };
}

function decodeHttpScalarEncoding(
  value: unknown,
  encoding: Extract<HttpWireValuePlan, { kind: "scalar-encoding" }>["encoding"],
): unknown {
  try {
    switch (encoding) {
      case "number-string":
        return ScalarEncodings.decodeNumberString(requireString(value));
      case "integer-string":
        return ScalarEncodings.decodeIntegerString(requireString(value));
      case "boolean-string":
        return ScalarEncodings.decodeBooleanString(requireString(value));
      case "rfc7231":
        return ScalarEncodings.decodeRfc7231DateTime(requireString(value));
      case "unix-timestamp":
        return ScalarEncodings.decodeUnixTimestamp(requireHttpNumber(value, true));
      case "duration-seconds":
        return ScalarEncodings.decodeNumericDuration(requireHttpNumber(value, false), "seconds");
      case "duration-milliseconds":
        return ScalarEncodings.decodeNumericDuration(
          requireHttpNumber(value, false),
          "milliseconds",
        );
      case "base64url":
        return encodeBase64(ScalarEncodings.decodeBase64Url(requireString(value)));
    }
  } catch (error) {
    throw new McpToolError(`Upstream returned an invalid ${encoding} HTTP value.`, {
      cause: error,
    });
  }
}

function encodeHttpScalarEncoding(
  value: unknown,
  encoding: Extract<HttpWireValuePlan, { kind: "scalar-encoding" }>["encoding"],
): unknown {
  try {
    switch (encoding) {
      case "number-string":
        return ScalarEncodings.encodeNumberString(requireNumber(value));
      case "integer-string":
        return ScalarEncodings.encodeNumberString(requireNumber(value), { integer: true });
      case "boolean-string":
        if (typeof value !== "boolean") throw new TypeError("Expected a boolean.");
        return ScalarEncodings.encodeBooleanString(value);
      case "rfc7231":
        return ScalarEncodings.encodeRfc7231DateTime(requireString(value));
      case "unix-timestamp":
        return ScalarEncodings.encodeUnixTimestamp(requireString(value));
      case "duration-seconds":
        return ScalarEncodings.encodeNumericDuration(requireString(value), "seconds");
      case "duration-milliseconds":
        return ScalarEncodings.encodeNumericDuration(requireString(value), "milliseconds");
      case "base64url":
        return ScalarEncodings.encodeBase64Url(decodeBase64(requireString(value)));
    }
  } catch (error) {
    throw new McpToolError(`Expected a valid ${encoding} HTTP request value.`, { cause: error });
  }
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Expected a string.");
  return value;
}

function requireNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Expected a finite number.");
  }
  return value;
}

function requireHttpNumber(value: unknown, integer: boolean): number {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(number) || (integer && !Number.isSafeInteger(number))) {
    throw new TypeError(`Expected a finite ${integer ? "integer" : "number"}.`);
  }
  return number;
}

interface FileRecord {
  readonly name: string;
  readonly data: string;
  readonly mediaType?: string;
}

function asFileRecord(value: unknown): FileRecord {
  if (!isFileRecord(value)) throw new McpToolError("Expected a JSON file record.");
  return value;
}

function isFileRecord(value: unknown): value is FileRecord {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.data === "string" &&
    (value.mediaType === undefined || typeof value.mediaType === "string")
  );
}

function getSourceValue(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment))
      return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

function setTargetValue(
  output: unknown,
  target: string | readonly (string | number)[],
  value: unknown,
): unknown {
  const path = typeof target === "string" ? [target] : target;
  if (path.length === 0) return value;
  let root = output;
  if (
    !isContainer(root) ||
    (typeof path[0] === "number" && isRecord(root) && Object.keys(root).length === 0)
  ) {
    root = typeof path[0] === "number" ? [] : Object.create(null);
  }
  let current = root as Record<PropertyKey, unknown>;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const nextSegment = path[index + 1]!;
    const existing = current[segment];
    if (!isContainer(existing)) {
      current[segment] = typeof nextSegment === "number" ? [] : Object.create(null);
    }
    current = current[segment] as Record<PropertyKey, unknown>;
  }
  current[path.at(-1)!] = value;
  return root;
}

function isContainer(value: unknown): value is Record<PropertyKey, unknown> | unknown[] {
  return Array.isArray(value) || isRecord(value);
}

function splitHttpList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return String(value);
  if (value === null) return "";
  throw new McpToolError(
    `Expected an HTTP scalar, received ${Array.isArray(value) ? "array" : typeof value}.`,
  );
}

function objectPairs(value: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(value).flatMap(([key, item]) => [key, scalar(item)]);
}

function setSafeHeader(headers: Headers, name: string, value: string): void {
  if (/\r|\n/.test(name) || /\r|\n/.test(value))
    throw new McpToolError("Rejected invalid HTTP header value.");
  headers.set(name, value);
}

function normalizeOrigins(origins: readonly string[] | undefined): Set<string> {
  const output = new Set<string>();
  for (const origin of origins ?? []) {
    const url = new URL(origin);
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
      throw new TypeError(`Expected an upstream origin, received ${origin}.`);
    }
    output.add(url.origin);
  }
  return output;
}

function boundedInteger(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new TypeError(`${name} must be an integer >= ${minimum}.`);
  return value;
}

function httpClientFailure(error: unknown): McpToolError {
  if (!(error instanceof HttpClientError)) {
    return error instanceof McpToolError
      ? error
      : new McpToolError("Upstream request failed.", { cause: error });
  }
  const message =
    error.code === "timeout"
      ? "Upstream request timed out."
      : error.code === "cancelled"
        ? "Upstream request was cancelled."
        : error.message.replace(/^HTTP /, "Upstream ");
  return new McpToolError(message, { cause: error });
}

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new McpToolError("Expected valid base64 data.");
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function asBodyBytes(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

async function fileToRecord(file: File): Promise<FileRecord> {
  return {
    name: file.name,
    ...(file.type ? { mediaType: file.type } : {}),
    data: encodeBase64(new Uint8Array(await file.arrayBuffer())),
  };
}

function responseFileName(disposition: string | null): string | undefined {
  if (!disposition) return undefined;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (utf8) {
    try {
      return decodeURIComponent(utf8);
    } catch {
      return undefined;
    }
  }
  return (
    /filename="([^"]+)"/i.exec(disposition)?.[1] ??
    /filename=([^;]+)/i.exec(disposition)?.[1]?.trim()
  );
}

interface MutableCredentials {
  headers: Record<string, string>;
  query: Record<string, string>;
  cookies: Record<string, string>;
}

function applyStaticCredential(
  output: MutableCredentials,
  scheme: HttpAuthScheme,
  configured: StaticHttpCredential,
): void {
  const value = typeof configured === "string" ? configured : configured.value;
  const prefix = typeof configured === "string" ? undefined : configured.prefix;
  if (scheme.type === "apiKey") {
    output[
      scheme.location === "header" ? "headers" : scheme.location === "query" ? "query" : "cookies"
    ][scheme.name] = value;
    return;
  }
  const defaultPrefix =
    scheme.type === "http" && scheme.scheme.toLowerCase() !== "bearer" ? scheme.scheme : "Bearer";
  output.headers.Authorization = `${prefix ?? defaultPrefix} ${value}`;
}

function compactCredentials(credentials: MutableCredentials): HttpAuthCredentials {
  return {
    ...(Object.keys(credentials.headers).length > 0 ? { headers: credentials.headers } : {}),
    ...(Object.keys(credentials.query).length > 0 ? { query: credentials.query } : {}),
    ...(Object.keys(credentials.cookies).length > 0 ? { cookies: credentials.cookies } : {}),
  };
}

function runtimeEnvironment(): Readonly<Record<string, string | undefined>> {
  return (
    (
      globalThis as typeof globalThis & {
        process?: { readonly env?: Readonly<Record<string, string | undefined>> };
      }
    ).process?.env ?? {}
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
