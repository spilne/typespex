export const HTTP_OPERATION_PLAN_VERSION = 1 as const;

/** Data-only wire transform shared by compiler plans and protocol clients. */
export type HttpWireValuePlan =
  | { readonly kind: "identity" }
  | {
      /** Introduces a recursively referenceable wire transform for the nested value. */
      readonly kind: "definition";
      readonly name: string;
      readonly value: HttpWireValuePlan;
    }
  | { readonly kind: "ref"; readonly name: string }
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
      readonly properties: Readonly<Record<string, HttpWirePropertyPlan>>;
      readonly additional?: HttpWireValuePlan;
    }
  | { readonly kind: "union"; readonly variants: readonly HttpWireValuePlan[] };

export interface HttpWirePropertyPlan {
  readonly sourceName: string;
  readonly value: HttpWireValuePlan;
  readonly optional: boolean;
}

export type HttpAuthSchemePlan =
  | {
      readonly id: string;
      readonly type: "apiKey";
      readonly location: "header" | "query" | "cookie";
      readonly name: string;
    }
  | { readonly id: string; readonly type: "http"; readonly scheme: string }
  | { readonly id: string; readonly type: "oauth2" | "openIdConnect" };

export type HttpAuthAlternativePlan =
  | { readonly noAuth: true }
  | { readonly noAuth?: false; readonly schemes: readonly HttpAuthSchemePlan[] };

export interface HttpWireOperationPlan {
  readonly version: typeof HTTP_OPERATION_PLAN_VERSION;
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly literalQuery?: readonly HttpLiteralQueryPlan[];
  readonly parameters: readonly HttpParameterPlan[];
  readonly requestBody?: HttpBodyPlan;
  readonly responses: readonly HttpResponsePlan[];
  readonly servers?: readonly HttpServerPlan[];
  readonly auth?: readonly HttpAuthAlternativePlan[];
}

export interface HttpParameterPlan {
  readonly source: readonly (string | number)[];
  readonly wireName: string;
  readonly location: "path" | "query" | "header" | "cookie";
  readonly required: boolean;
  readonly style?:
    | "simple"
    | "label"
    | "matrix"
    | "path"
    | "form"
    | "spaceDelimited"
    | "pipeDelimited"
    | "deepObject";
  readonly explode?: boolean;
  readonly allowReserved?: boolean;
  readonly value?: HttpWireValuePlan;
}

export interface HttpBodyPlan {
  readonly source?: readonly (string | number)[];
  readonly fields?: readonly HttpBodyFieldPlan[];
  readonly kind: "json" | "form" | "multipart" | "text" | "binary" | "file" | "jsonl";
  readonly contentTypes: readonly string[];
  readonly contentTypeSource?: readonly (string | number)[];
  readonly mediaTypes?: readonly HttpBodyMediaTypePlan[];
  readonly multipartParts?: readonly HttpMultipartPartPlan[];
  readonly value?: HttpWireValuePlan;
}

export interface HttpBodyMediaTypePlan {
  readonly contentType: string;
  readonly kind: HttpBodyPlan["kind"];
  readonly value?: HttpWireValuePlan;
}

export interface HttpMultipartPartPlan {
  readonly source: readonly (string | number)[];
  readonly name?: string;
  readonly multi: boolean;
  readonly optional: boolean;
  readonly kind: Exclude<HttpBodyPlan["kind"], "multipart" | "jsonl" | "form">;
  readonly contentTypes: readonly string[];
  readonly value?: HttpWireValuePlan;
}

export interface HttpLiteralQueryPlan {
  readonly name: string;
  readonly value: string;
}

export interface HttpBodyFieldPlan {
  readonly source: readonly (string | number)[];
  readonly target: readonly (string | number)[];
}

export interface HttpResponsePlan {
  readonly statusCodes: readonly (number | `${number}XX` | "default")[];
  readonly contentTypes: readonly string[];
  readonly kind: "json" | "form" | "multipart" | "text" | "binary" | "file" | "jsonl" | "empty";
  readonly error: boolean;
  readonly bodyValue?: HttpWireValuePlan;
  readonly multipartParts?: readonly HttpResponseMultipartPartPlan[];
  readonly bodyTarget?: readonly (string | number)[];
  readonly statusTarget?: readonly (string | number)[];
  readonly contentTypeTarget?: readonly (string | number)[];
  readonly headers?: readonly HttpResponseHeaderPlan[];
}

export interface HttpResponseMultipartPartPlan {
  readonly target: readonly (string | number)[];
  readonly name?: string;
  readonly multi: boolean;
  readonly optional: boolean;
  readonly kind: "json" | "text" | "binary" | "file";
  readonly contentTypes: readonly string[];
  readonly value?: HttpWireValuePlan;
}

export interface HttpResponseHeaderPlan {
  readonly wireName: string;
  readonly target: readonly (string | number)[];
  readonly collection?: boolean;
  readonly value?: HttpWireValuePlan;
}

export interface HttpServerPlan {
  readonly url: string;
  readonly fullyDefaulted: boolean;
}

export type HttpClientErrorCode =
  | "invalid-url"
  | "cancelled"
  | "timeout"
  | "network"
  | "redirect-limit"
  | "redirect-body"
  | "redirect-origin"
  | "redirect-scheme"
  | "body-limit"
  | "jsonl-item-limit"
  | "invalid-jsonl";

export class HttpClientError extends Error {
  constructor(
    readonly code: HttpClientErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "HttpClientError";
  }
}

export interface HttpClientPolicy {
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  /** Deadline for receiving response headers across the complete redirect chain. */
  readonly headersTimeoutMs?: number;
  /** Defaults to three. Retries are intentionally not implemented. */
  readonly maxRedirects?: number;
  /** Additional origins allowed for cross-origin redirects. */
  readonly allowedRedirectOrigins?: readonly string[];
  /** Credential-bearing query parameters removed before every redirect. */
  readonly sensitiveQueryParameters?: readonly string[];
  /** Headers removed according to the redirect credential policy. */
  readonly sensitiveHeaders?: readonly string[];
  /**
   * Retain sensitive headers on same-origin redirects. Defaults to false so
   * credentials are stripped on every redirect; cross-origin hops always strip them.
   */
  readonly preserveSensitiveHeadersOnSameOriginRedirects?: boolean;
}

/**
 * Executes one HTTP request with bounded manual redirects and credential
 * stripping. It deliberately performs no retries.
 */
export async function executeHttpRequest(
  input: string | URL,
  init: RequestInit = {},
  policy: HttpClientPolicy = {},
): Promise<Response> {
  const fetchImplementation = policy.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new HttpClientError("network", "No Fetch implementation is available.");
  }
  const maxRedirects = positiveInteger(policy.maxRedirects ?? 3, "maxRedirects", 0);
  const headersTimeout =
    policy.headersTimeoutMs === undefined
      ? undefined
      : positiveInteger(policy.headersTimeoutMs, "headersTimeoutMs", 1);
  const allowedOrigins = new Set((policy.allowedRedirectOrigins ?? []).map(normalizeOrigin));
  const sensitiveQuery = new Set(policy.sensitiveQueryParameters ?? []);
  const sensitiveHeaders = policy.sensitiveHeaders ?? [
    "Authorization",
    "Proxy-Authorization",
    "Cookie",
  ];
  const timeoutController = headersTimeout === undefined ? undefined : new AbortController();
  const timer = timeoutController
    ? setTimeout(() => timeoutController.abort(), headersTimeout)
    : undefined;
  const signals = [policy.signal, init.signal, timeoutController?.signal].filter(
    (candidate): candidate is AbortSignal => candidate !== undefined,
  );
  const signal =
    signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  let url = parseHttpUrl(input, "HTTP request URL");
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  const headers = new Headers(init.headers);

  try {
    for (let redirects = 0; ; redirects += 1) {
      let response: Response;
      try {
        response = await fetchImplementation(url, {
          ...init,
          method,
          headers,
          body: method === "GET" || method === "HEAD" ? undefined : body,
          redirect: "manual",
          signal,
        });
      } catch (error) {
        if (signal?.aborted) {
          throw new HttpClientError(
            timeoutController?.signal.aborted ? "timeout" : "cancelled",
            timeoutController?.signal.aborted
              ? "Timed out while waiting for HTTP response headers."
              : "HTTP request was cancelled.",
            { cause: error },
          );
        }
        throw new HttpClientError("network", "HTTP request failed.", { cause: error });
      }
      if (!isRedirect(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      if (redirects >= maxRedirects) {
        await cancelResponseBody(response);
        throw new HttpClientError("redirect-limit", "HTTP redirect limit exceeded.");
      }
      let redirected: URL;
      try {
        redirected = parseHttpUrl(location, "HTTP redirect URL", "redirect-scheme", url);
      } catch (error) {
        await cancelResponseBody(response);
        throw error;
      }
      const crossOrigin = redirected.origin !== url.origin;
      if (crossOrigin && !allowedOrigins.has(redirected.origin)) {
        await cancelResponseBody(response);
        throw new HttpClientError(
          "redirect-origin",
          `Rejected cross-origin redirect to ${redirected.origin}.`,
        );
      }
      if (crossOrigin || !policy.preserveSensitiveHeadersOnSameOriginRedirects) {
        for (const header of sensitiveHeaders) headers.delete(header);
      }
      for (const name of sensitiveQuery) redirected.searchParams.delete(name);
      if (
        (response.status === 303 && method !== "GET" && method !== "HEAD") ||
        ((response.status === 301 || response.status === 302) && method === "POST")
      ) {
        method = "GET";
        body = undefined;
        headers.delete("Content-Type");
        headers.delete("Content-Length");
      }
      if (method !== "GET" && method !== "HEAD" && isOneShotBody(body)) {
        await cancelResponseBody(response);
        throw new HttpClientError(
          "redirect-body",
          "Cannot replay a streaming HTTP request body across a redirect.",
        );
      }
      await cancelResponseBody(response);
      url = redirected;
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const maximum = positiveInteger(maximumBytes, "maximumBytes", 1);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await readStreamChunk(reader, signal, "HTTP response was cancelled.");
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximum) {
        throw new HttpClientError("body-limit", `HTTP response exceeded ${maximum} bytes.`);
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    await cancelReader(reader, error);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function readBoundedJsonLines(
  response: Response,
  limits: { readonly maximumItems: number; readonly maximumBytes: number },
  signal?: AbortSignal,
): Promise<unknown[]> {
  const maximumItems = positiveInteger(limits.maximumItems, "maximumItems", 1);
  const maximumBytes = positiveInteger(limits.maximumBytes, "maximumBytes", 1);
  if (!response.body) return [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const output: unknown[] = [];
  let pending = "";
  let bytes = 0;
  try {
    while (true) {
      const chunk = await readStreamChunk(reader, signal, "HTTP response was cancelled.");
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        throw new HttpClientError(
          "body-limit",
          `HTTP JSONL response exceeded ${maximumBytes} bytes.`,
        );
      }
      pending += decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) pushJsonLine(output, line, maximumItems);
      }
    }
    pending += decoder.decode();
    if (pending.trim()) pushJsonLine(output, pending.trim(), maximumItems);
    return output;
  } catch (error) {
    await cancelReader(reader, error);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
): Promise<void> {
  try {
    await reader.cancel(reason);
  } catch {
    // Cleanup must not replace the original transport failure.
  }
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  message: string,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) throw cancelledError(message, signal.reason);

  let rejectAborted: ((reason: HttpClientError) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = () => rejectAborted?.(cancelledError(message, signal.reason));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([reader.read(), aborted]);
  } catch (error) {
    if (signal.aborted && !(error instanceof HttpClientError)) {
      throw cancelledError(message, error);
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function cancelledError(message: string, cause: unknown): HttpClientError {
  return new HttpClientError("cancelled", message, { cause });
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup must not replace the redirect policy result.
  }
}

function pushJsonLine(output: unknown[], line: string, maximumItems: number): void {
  if (output.length >= maximumItems) {
    throw new HttpClientError(
      "jsonl-item-limit",
      `HTTP JSONL response exceeded ${maximumItems} items.`,
    );
  }
  try {
    output.push(JSON.parse(line));
  } catch (error) {
    throw new HttpClientError("invalid-jsonl", "HTTP response contained invalid JSONL.", {
      cause: error,
    });
  }
}

function normalizeOrigin(origin: string): string {
  const url = parseHttpUrl(origin, "redirect origin");
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new TypeError(`Expected an origin, received ${origin}.`);
  }
  return url.origin;
}

function parseHttpUrl(
  input: string | URL,
  label: string,
  schemeErrorCode: "invalid-url" | "redirect-scheme" = "invalid-url",
  base?: URL,
): URL {
  let url: URL;
  try {
    url = new URL(input, base);
  } catch (error) {
    throw new HttpClientError("invalid-url", `${label} is invalid.`, { cause: error });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HttpClientError(
      schemeErrorCode,
      `${label} must use HTTP or HTTPS; received ${url.protocol}.`,
    );
  }
  if (url.username || url.password) {
    throw new HttpClientError("invalid-url", `${label} must not contain embedded credentials.`);
  }
  return url;
}

function positiveInteger(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}.`);
  }
  return value;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isOneShotBody(body: BodyInit | null | undefined): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (typeof (body as { readonly getReader?: unknown }).getReader === "function" ||
      typeof (body as { readonly [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] ===
        "function")
  );
}
