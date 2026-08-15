import { bytesToBase64, stringifyJson } from "./json.js";
import { isContentTypeAccepted, parseMediaType } from "./media-type.js";

/** Runtime response encoder that turns one typed output value into an HTTP response. */
export abstract class ResponseEncoder<A> {
  abstract encode(value: A): Response;

  static of<A>(encode: (value: A) => Response): ResponseEncoder<A> {
    return new FnResponseEncoder(encode);
  }

  mapInput<B>(f: (value: B) => A): ResponseEncoder<B> {
    return ResponseEncoder.of((value) => this.encode(f(value)));
  }
}

class FnResponseEncoder<A> extends ResponseEncoder<A> {
  constructor(private readonly encodeFn: (value: A) => Response) {
    super();
  }

  encode(value: A): Response {
    return this.encodeFn(value);
  }
}

function responseInit(status: number, init?: ResponseInit): ResponseInit {
  return { ...init, status: validateFetchResponseStatus(status) };
}

function jsonResponseEncoder<A>(status = 200, init?: ResponseInit): ResponseEncoder<A> {
  return ResponseEncoder.of((value) => {
    const response = responseInit(status, init);
    return isBodyForbiddenStatus(status)
      ? new Response(null, response)
      : new Response(stringifyJson(value), withContentType(response, "application/json"));
  });
}

function jsonlResponseEncoder<A>(
  status = 200,
  transformItem?: (value: A) => unknown,
): ResponseEncoder<AsyncIterable<A>> {
  return ResponseEncoder.of((values) => {
    const response = responseInit(status);
    return isBodyForbiddenStatus(status)
      ? new Response(null, response)
      : new Response(jsonlResponseBody(values, transformItem), {
          ...response,
          headers: { "content-type": "application/jsonl" },
        });
  });
}

function jsonlResponseBody<A>(
  values: AsyncIterable<A>,
  transformItem?: (value: A) => unknown,
): ReadableStream<Uint8Array> {
  if (
    typeof values !== "object" ||
    values === null ||
    typeof values[Symbol.asyncIterator] !== "function"
  ) {
    throw new TypeError("JSONL responses require an AsyncIterable value.");
  }

  const iterator = values[Symbol.asyncIterator]();
  const textEncoder = new TextEncoder();
  let finished = false;

  const closeIterator = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    await iterator.return?.();
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) {
            finished = true;
            controller.close();
            return;
          }

          const item = transformItem ? transformItem(next.value) : next.value;
          controller.enqueue(textEncoder.encode(`${stringifyJson(item)}\n`));
        } catch (error) {
          try {
            await closeIterator();
          } catch {
            // Preserve the iteration or serialization failure.
          }
          controller.error(error);
        }
      },
      async cancel() {
        await closeIterator();
      },
    },
    { highWaterMark: 0 },
  );
}

/** One server-sent event after its payload has been serialized for the wire. */
export interface SseEvent {
  /** Named SSE event type. Omit this field for the default `message` event. */
  readonly event?: string;
  /** Serialized event payload. Each normalized line is emitted as one `data:` field. */
  readonly data: string;
  /** Close the stream after emitting this event. */
  readonly terminal?: boolean;
}

function sseResponseEncoder<A = SseEvent>(
  status = 200,
  transformEvent?: (value: A) => SseEvent,
): ResponseEncoder<AsyncIterable<A>> {
  return ResponseEncoder.of((values) => {
    const response = responseInit(status);
    return isBodyForbiddenStatus(status)
      ? new Response(null, response)
      : new Response(sseResponseBody(values, transformEvent), {
          ...response,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
  });
}

function sseResponseBody<A>(
  values: AsyncIterable<A>,
  transformEvent?: (value: A) => SseEvent,
): ReadableStream<Uint8Array> {
  if (
    typeof values !== "object" ||
    values === null ||
    typeof values[Symbol.asyncIterator] !== "function"
  ) {
    throw new TypeError("SSE responses require an AsyncIterable value.");
  }

  const iterator = values[Symbol.asyncIterator]();
  const textEncoder = new TextEncoder();
  let finished = false;

  const closeIterator = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    await iterator.return?.();
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) {
            finished = true;
            controller.close();
            return;
          }

          const event = transformEvent
            ? transformEvent(next.value)
            : (next.value as unknown as SseEvent);
          const encoded = encodeSseEvent(event);
          controller.enqueue(textEncoder.encode(encoded.frame));
          if (encoded.terminal) {
            await closeIterator();
            controller.close();
          }
        } catch (error) {
          try {
            await closeIterator();
          } catch {
            // Preserve the iteration, transformation, framing, or terminal cleanup failure.
          }
          controller.error(error);
        }
      },
      async cancel() {
        await closeIterator();
      },
    },
    { highWaterMark: 0 },
  );
}

function encodeSseEvent(value: SseEvent): { readonly frame: string; readonly terminal: boolean } {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("SSE events must be objects.");
  }
  const { data, event, terminal } = value;
  if (typeof data !== "string") {
    throw new TypeError("SSE event data must be a string.");
  }
  if (event !== undefined && typeof event !== "string") {
    throw new TypeError("SSE event names must be strings when provided.");
  }
  if (event !== undefined && /[\0\r\n]/u.test(event)) {
    throw new TypeError("SSE event names cannot contain null or newline characters.");
  }
  if (terminal !== undefined && typeof terminal !== "boolean") {
    throw new TypeError("SSE terminal markers must be booleans when provided.");
  }

  const eventField = event === undefined ? "" : `event: ${event}\n`;
  const dataFields = data
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => `data: ${line}\n`)
    .join("");
  return { frame: `${eventField}${dataFields}\n`, terminal: terminal === true };
}

function emptyResponseEncoder(status = 204, init?: ResponseInit): ResponseEncoder<void> {
  return ResponseEncoder.of(() => new Response(null, responseInit(status, init)));
}

function textResponseEncoder(status = 200, init?: ResponseInit): ResponseEncoder<string> {
  return ResponseEncoder.of((value) => {
    const response = responseInit(status, init);
    return isBodyForbiddenStatus(status)
      ? new Response(null, response)
      : new Response(value, withContentType(response, "text/plain; charset=utf-8"));
  });
}

function xmlResponseEncoder(status = 200, init?: ResponseInit): ResponseEncoder<string> {
  return ResponseEncoder.of((value) => {
    const response = responseInit(status, init);
    return isBodyForbiddenStatus(status)
      ? new Response(null, response)
      : new Response(value, withContentType(response, "application/xml"));
  });
}

function bytesResponseEncoder(status = 200, init?: ResponseInit): ResponseEncoder<Uint8Array> {
  return ResponseEncoder.of((value) => {
    const response = responseInit(status, init);
    return isBodyForbiddenStatus(status)
      ? new Response(null, response)
      : new Response(
          new Uint8Array(value).buffer,
          withContentType(response, "application/octet-stream"),
        );
  });
}

export interface FileResponseOptions {
  readonly requireContentType?: boolean;
  readonly requireFileName?: boolean;
  readonly emitContentDisposition?: boolean;
}

function fileResponseEncoder(
  status = 200,
  contentTypes: readonly string[] = [],
  options: FileResponseOptions = {},
): ResponseEncoder<File> {
  return ResponseEncoder.of((file) => {
    if (isBodyForbiddenStatus(status)) {
      return new Response(null, responseInit(status));
    }
    return encodeFileResponse(file, status, new Headers(), contentTypes, options);
  });
}

function withContentType(init: ResponseInit, contentType: string): ResponseInit {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", contentType);
  return { ...init, headers };
}

function rawResponseEncoder(): ResponseEncoder<Response> {
  return ResponseEncoder.of((value) => value);
}

function streamResponseEncoder(
  status = 200,
  contentType = "application/octet-stream",
): ResponseEncoder<ReadableStream> {
  return ResponseEncoder.of((stream) => {
    const response = responseInit(status);
    return isBodyForbiddenStatus(status)
      ? new Response(null, response)
      : new Response(stream, {
          ...response,
          headers: { "content-type": contentType },
        });
  });
}

/**
 * JSON response encoder that extracts named properties as HTTP headers.
 * Partitions the value in a single pass: header properties become response
 * headers, everything else goes into the JSON body. No copy, no delete.
 */
function jsonWithHeadersResponseEncoder<A>(
  status: number,
  headers: ReadonlyArray<ResponseHeaderDescriptor>,
  transformBody?: (value: unknown) => unknown,
): ResponseEncoder<A> {
  const headerMap = new Map(
    headers.map(([property, header, explode, transform]) => [
      property,
      { header, explode, transform },
    ]),
  );
  return ResponseEncoder.of((value) => {
    const src = value as Record<string, unknown>;
    const responseHeaders = new Headers();
    const body: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(src)) {
      const header = headerMap.get(key);
      if (header !== undefined) {
        const v = src[key];
        if (v !== undefined) {
          setResponseHeader(
            responseHeaders,
            header.header,
            header.transform ? header.transform(v) : v,
            header.explode,
          );
        }
      } else {
        body[key] = src[key];
      }
    }
    if (isBodyForbiddenStatus(status)) {
      return new Response(null, responseInit(status, { headers: responseHeaders }));
    }
    responseHeaders.set("content-type", "application/json");
    return new Response(
      stringifyJson(transformBody ? transformBody(body) : body),
      responseInit(status, { headers: responseHeaders }),
    );
  });
}

export interface ResponseStatusCodeRange {
  readonly start: number;
  readonly end: number;
}

export interface DynamicResponseStatus {
  readonly property: string;
  readonly allowed: readonly (number | ResponseStatusCodeRange)[];
}

export type ResponseHeaderDescriptor = readonly [
  property: string,
  header: string,
  explode?: boolean,
  transform?: (value: unknown) => unknown,
];

export interface ResponseVariant {
  readonly status: number | DynamicResponseStatus;
  readonly kind?: "json" | "xml" | "text" | "bytes" | "file" | "empty";
  readonly headers?: ReadonlyArray<ResponseHeaderDescriptor>;
  readonly body?: string;
  readonly omit?: readonly string[];
  readonly contentType?: string;
  readonly contentTypes?: readonly string[];
  readonly requireFileContentType?: boolean;
  readonly requireFileName?: boolean;
  readonly emitFileContentDisposition?: boolean;
  /** Converts the resolved handler-facing body to its declared wire representation. */
  readonly transformBody?: (value: unknown) => unknown;
}

export interface ResponseVariantMatch<A, B extends A = A> {
  readonly when: (value: A) => value is B;
  readonly encoder: ResponseEncoder<B>;
}

function encodeVariantResponse<A>(value: A, variant: ResponseVariant): Response {
  const src = value as Record<string, unknown>;
  const isObject = typeof value === "object" && value !== null;
  const status = resolveVariantStatus(src, isObject, variant.status);
  const responseHeaders = new Headers();
  if (isObject) {
    for (const [property, header, explode, transform] of variant.headers ?? []) {
      const v = src[property];
      if (v !== undefined) {
        setResponseHeader(responseHeaders, header, transform ? transform(v) : v, explode);
      }
    }
  }

  if (variant.kind === "empty" || isBodyForbiddenStatus(status)) {
    return new Response(null, { status, headers: responseHeaders });
  }

  const contentType = variant.contentType ?? defaultContentTypeForKind(variant.kind);
  if (contentType && !responseHeaders.has("content-type")) {
    responseHeaders.set("content-type", contentType);
  }

  const resolvedBody =
    variant.kind === "file" && variant.body === undefined
      ? value
      : resolveVariantBody(value, src, isObject, variant);
  const body = variant.transformBody ? variant.transformBody(resolvedBody) : resolvedBody;

  if (variant.kind === "text") {
    return new Response(String(body ?? ""), {
      status,
      headers: responseHeaders,
    });
  }

  if (variant.kind === "xml") {
    return new Response(String(body ?? ""), {
      status,
      headers: responseHeaders,
    });
  }

  if (variant.kind === "bytes") {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array();
    return new Response(new Uint8Array(bytes).buffer, {
      status,
      headers: responseHeaders,
    });
  }

  if (variant.kind === "file") {
    return encodeFileResponse(body, status, responseHeaders, variant.contentTypes ?? [], {
      requireContentType: variant.requireFileContentType,
      requireFileName: variant.requireFileName,
      emitContentDisposition: variant.emitFileContentDisposition,
    });
  }

  return new Response(body === undefined ? null : stringifyJson(body), {
    status,
    headers: responseHeaders,
  });
}

function encodeFileResponse(
  value: unknown,
  status: number,
  headers: Headers,
  contentTypes: readonly string[],
  options: FileResponseOptions = {},
): Response {
  if (typeof File === "undefined" || !(value instanceof File)) {
    throw new TypeError("File responses require a Web File value.");
  }

  const fileContentType = value.type || undefined;
  const headerContentType = headers.get("content-type") || undefined;
  const fileMediaType = parseMediaType(fileContentType);
  const headerMediaType = parseMediaType(headerContentType);
  if (
    fileContentType &&
    headerContentType &&
    (!fileMediaType || fileMediaType !== headerMediaType)
  ) {
    throw new TypeError(
      `File content type "${fileContentType}" conflicts with response Content-Type "${headerContentType}".`,
    );
  }

  const contentType = headerContentType ?? fileContentType;
  if (!contentType && options.requireContentType) {
    throw new TypeError("File responses require a content type for this contract.");
  }
  if (contentType && contentTypes.length > 0 && !isContentTypeAccepted(contentType, contentTypes)) {
    throw new RangeError(`File content type "${contentType}" is outside its declared contract.`);
  }
  if (fileContentType && !headerContentType) {
    headers.set("content-type", fileContentType);
  }
  const filename = typeof value.name === "string" ? value.name : "";
  if (
    options.emitContentDisposition !== false &&
    (filename || options.requireFileName) &&
    !headers.has("content-disposition")
  ) {
    headers.set("content-disposition", formatFileContentDisposition(filename));
  }

  return new Response(value, { status, headers });
}

function formatFileContentDisposition(filename: string): string {
  if (/[\u0000-\u001f\u007f/\\]/.test(filename)) {
    throw new TypeError(
      "File names used in HTTP responses cannot contain control characters or path separators.",
    );
  }

  const fallback = filename
    .replace(/[^\u0020-\u007e]/g, "_")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  const quoted = `attachment; filename="${fallback}"`;
  if (/^[\u0020-\u007e]*$/.test(filename)) return quoted;

  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${quoted}; filename*=UTF-8''${encoded}`;
}

function resolveVariantStatus(
  src: Record<string, unknown>,
  isObject: boolean,
  status: ResponseVariant["status"],
): number {
  if (typeof status === "number") return validateFetchResponseStatus(status);
  if (!isObject || !Object.prototype.hasOwnProperty.call(src, status.property)) {
    throw new TypeError(`Response status property "${status.property}" is required.`);
  }

  const value = src[status.property];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`Response status property "${status.property}" must be an integer.`);
  }
  validateFetchResponseStatus(value);

  const allowed = status.allowed.some((entry) =>
    typeof entry === "number" ? value === entry : value >= entry.start && value <= entry.end,
  );
  if (!allowed) {
    throw new RangeError(
      `Response status property "${status.property}" is outside its declared contract.`,
    );
  }
  return value;
}

function validateFetchResponseStatus(status: number): number {
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new RangeError(`Fetch Response status must be an integer between 200 and 599.`);
  }
  return status;
}

function isBodyForbiddenStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

function setResponseHeader(headers: Headers, name: string, value: unknown, explode = false): void {
  if (name.toLowerCase() === "set-cookie" && Array.isArray(value)) {
    for (const item of value) headers.append(name, headerScalar(item));
    return;
  }
  headers.set(name, serializeHeaderValue(value, explode));
}

function serializeHeaderValue(value: unknown, explode: boolean): string {
  if (value instanceof Uint8Array) {
    return headerScalar(value);
  }
  if (Array.isArray(value)) {
    return value.map(headerScalar).join(",");
  }

  if (typeof value === "object" && value !== null) {
    if (!isPlainObject(value)) {
      throw new TypeError("HTTP structured header values must be plain objects.");
    }
    const fields = Object.entries(value).filter(([, item]) => item !== undefined);
    return fields
      .flatMap(([key, item]) =>
        explode ? [`${key}=${headerScalar(item)}`] : [key, headerScalar(item)],
      )
      .join(",");
  }

  return headerScalar(value);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function headerScalar(value: unknown): string {
  if (value instanceof Uint8Array) return bytesToBase64(value);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  throw new TypeError("HTTP header values must contain only scalar values.");
}

function resolveVariantBody<A>(
  value: A,
  src: Record<string, unknown>,
  isObject: boolean,
  variant: ResponseVariant,
): unknown {
  if (variant.body === undefined) {
    return isObject ? omitVariantProperties(src, variant) : value;
  }
  return isObject ? src[variant.body] : undefined;
}

function omitVariantProperties(src: Record<string, unknown>, variant: ResponseVariant): unknown {
  const omit = new Set<string>(variant.omit ?? []);
  for (const [property] of variant.headers ?? []) {
    omit.add(property);
  }

  if (omit.size === 0) return src;

  const body: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(src)) {
    if (!omit.has(key)) body[key] = src[key];
  }
  return body;
}

function defaultContentTypeForKind(kind: ResponseVariant["kind"]): string | undefined {
  switch (kind) {
    case "xml":
      return "application/xml";
    case "text":
      return "text/plain; charset=utf-8";
    case "bytes":
      return "application/octet-stream";
    case "file":
      return undefined;
    case "json":
    case undefined:
      return "application/json";
    default:
      return undefined;
  }
}

function variantResponseEncoder<A>(variant: ResponseVariant): ResponseEncoder<A> {
  return ResponseEncoder.of((value) => encodeVariantResponse(value, variant));
}

function matchVariantResponseEncoder<A>(
  cases: readonly ResponseVariantMatch<A>[],
): ResponseEncoder<A> {
  return ResponseEncoder.of((value) => {
    for (const match of cases) {
      if (match.when(value)) {
        return match.encoder.encode(value);
      }
    }

    return unreachableResponse(value);
  });
}

function unreachableResponse(value: unknown): never {
  throw new TypeError(
    `Result value did not match any declared HTTP response variant: ${String(value)}`,
  );
}

/**
 * Encoder placeholder for response variants whose declared content type the
 * emitter cannot serialize. Construction is free; calling `encode` throws
 * so that any code path that bypassed the emitter diagnostic fails loudly
 * instead of returning a misleading response.
 */
function unsupportedResponseEncoder<A>(reason: string): ResponseEncoder<A> {
  return ResponseEncoder.of(() => {
    throw new TypeError(reason);
  });
}

export const ResponseEncoders = {
  json: jsonResponseEncoder,
  jsonl: jsonlResponseEncoder,
  sse: sseResponseEncoder,
  jsonWithHeaders: jsonWithHeadersResponseEncoder,
  empty: emptyResponseEncoder,
  xml: xmlResponseEncoder,
  text: textResponseEncoder,
  bytes: bytesResponseEncoder,
  file: fileResponseEncoder,
  stream: streamResponseEncoder,
  response: rawResponseEncoder,
  variant: variantResponseEncoder,
  matchVariant: matchVariantResponseEncoder,
  unreachable: unreachableResponse,
  unsupported: unsupportedResponseEncoder,
} as const;
