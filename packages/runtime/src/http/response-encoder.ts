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
  return { ...init, status };
}

function jsonResponseEncoder<A>(
  status = 200,
  init?: ResponseInit,
): ResponseEncoder<A> {
  return ResponseEncoder.of((value) =>
    Response.json(value, responseInit(status, init)),
  );
}

function emptyResponseEncoder(
  status = 204,
  init?: ResponseInit,
): ResponseEncoder<void> {
  return ResponseEncoder.of(() =>
    new Response(null, responseInit(status, init)),
  );
}

function textResponseEncoder(
  status = 200,
  init?: ResponseInit,
): ResponseEncoder<string> {
  return ResponseEncoder.of((value) =>
    new Response(value, responseInit(status, init)),
  );
}

function bytesResponseEncoder(
  status = 200,
  init?: ResponseInit,
): ResponseEncoder<Uint8Array> {
  return ResponseEncoder.of((value) =>
    new Response(new Uint8Array(value).buffer, responseInit(status, init)),
  );
}

function rawResponseEncoder(): ResponseEncoder<Response> {
  return ResponseEncoder.of((value) => value);
}

function streamResponseEncoder(
  status = 200,
  contentType = "application/octet-stream",
): ResponseEncoder<ReadableStream> {
  return ResponseEncoder.of((stream) =>
    new Response(stream, responseInit(status, { headers: { "content-type": contentType } })),
  );
}

/**
 * JSON response encoder that extracts named properties as HTTP headers.
 * Partitions the value in a single pass: header properties become response
 * headers, everything else goes into the JSON body. No copy, no delete.
 */
function jsonWithHeadersResponseEncoder<A>(
  status: number,
  headers: ReadonlyArray<readonly [property: string, header: string]>,
): ResponseEncoder<A> {
  const headerMap = new Map(headers);
  return ResponseEncoder.of((value) => {
    const src = value as Record<string, unknown>;
    const responseHeaders: Record<string, string> = { "content-type": "application/json" };
    const body: Record<string, unknown> = {};
    for (const key of Object.keys(src)) {
      const headerName = headerMap.get(key);
      if (headerName !== undefined) {
        const v = src[key];
        if (v !== undefined && (typeof v !== "object" || v === null)) {
          responseHeaders[headerName] = String(v);
        }
      } else {
        body[key] = src[key];
      }
    }
    return new Response(JSON.stringify(body), { status, headers: responseHeaders });
  });
}

export const ResponseEncoders = {
  json: jsonResponseEncoder,
  jsonWithHeaders: jsonWithHeadersResponseEncoder,
  empty: emptyResponseEncoder,
  text: textResponseEncoder,
  bytes: bytesResponseEncoder,
  stream: streamResponseEncoder,
  response: rawResponseEncoder,
} as const;

// ---------------------------------------------------------------------------
// Error encoders — data-driven error → Response mapping
// ---------------------------------------------------------------------------

/** Single-status JSON error encoder. */
function jsonErrorEncoder<E>(status: number): ResponseEncoder<E> {
  return jsonResponseEncoder(status);
}

/** Per-variant config: status code + optional header mappings. */
export interface ErrorVariant {
  readonly status: number;
  readonly headers?: ReadonlyArray<readonly [property: string, header: string]>;
}

/** Encodes a JSON error response, optionally extracting headers. */
function encodeErrorResponse<E>(error: E, status: number, headerDefs?: ReadonlyArray<readonly [string, string]>): Response {
  if (!headerDefs || headerDefs.length === 0) {
    return Response.json(error, { status });
  }
  const src = error as Record<string, unknown>;
  const responseHeaders: Record<string, string> = { "content-type": "application/json" };
  const body: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    let isHeader = false;
    for (const [prop, header] of headerDefs) {
      if (key === prop) {
        const v = src[key];
        if (v !== undefined && (typeof v !== "object" || v === null)) {
          responseHeaders[header] = String(v);
        }
        isHeader = true;
        break;
      }
    }
    if (!isHeader) body[key] = src[key];
  }
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

/** Discriminated by a field with unique literal values per variant. */
function discriminatedErrorEncoder<E>(
  field: string,
  variants: Readonly<Record<string, number | ErrorVariant>>,
  fallbackStatus = 500,
): ResponseEncoder<E> {
  return ResponseEncoder.of((error) => {
    const tag = (error as Record<string, unknown>)[field];
    const key = typeof tag === "string" || typeof tag === "number" ? String(tag) : undefined;
    const variant = key !== undefined ? variants[key] : undefined;
    if (variant === undefined) return encodeErrorResponse(error, fallbackStatus);
    if (typeof variant === "number") return encodeErrorResponse(error, variant);
    return encodeErrorResponse(error, variant.status, variant.headers);
  });
}

/** Discriminated by unique property existence per variant. */
function byPropertyErrorEncoder<E>(
  mapping: Readonly<Record<string, number | ErrorVariant>>,
  fallbackStatus = 500,
): ResponseEncoder<E> {
  const entries = Object.entries(mapping);
  return ResponseEncoder.of((error) => {
    const obj = error as Record<string, unknown>;
    for (const [prop, variant] of entries) {
      if (prop in obj) {
        if (typeof variant === "number") return encodeErrorResponse(error, variant);
        return encodeErrorResponse(error, variant.status, variant.headers);
      }
    }
    return encodeErrorResponse(error, fallbackStatus);
  });
}

/** Single-status JSON error encoder with response headers. */
function jsonWithHeadersErrorEncoder<E>(
  status: number,
  headers: ReadonlyArray<readonly [property: string, header: string]>,
): ResponseEncoder<E> {
  return ResponseEncoder.of((error) => encodeErrorResponse(error, status, headers));
}

export const ErrorEncoders = {
  /** Single-status — no discrimination needed. */
  json: jsonErrorEncoder,
  /** Single-status with response headers extracted from the error object. */
  jsonWithHeaders: jsonWithHeadersErrorEncoder,
  /** Discriminated by a field with unique literal values. */
  discriminated: discriminatedErrorEncoder,
  /** Discriminated by unique property existence. */
  byProperty: byPropertyErrorEncoder,
} as const;
