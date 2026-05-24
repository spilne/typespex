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
    new Response(value, withContentType(responseInit(status, init), "text/plain; charset=utf-8")),
  );
}

function bytesResponseEncoder(
  status = 200,
  init?: ResponseInit,
): ResponseEncoder<Uint8Array> {
  return ResponseEncoder.of((value) =>
    new Response(
      new Uint8Array(value).buffer,
      withContentType(responseInit(status, init), "application/octet-stream"),
    ),
  );
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

export interface ResponseVariant {
  readonly status: number;
  readonly kind?: "json" | "text" | "bytes" | "empty";
  readonly headers?: ReadonlyArray<readonly [property: string, header: string]>;
  readonly body?: string;
  readonly omit?: readonly string[];
  readonly contentType?: string;
}

export interface ResponseVariantMatch<A, B extends A = A> {
  readonly when: (value: A) => value is B;
  readonly encoder: ResponseEncoder<B>;
}

function encodeVariantResponse<A>(
  value: A,
  variant: ResponseVariant,
): Response {
  if (variant.kind === "empty") {
    return new Response(null, { status: variant.status });
  }

  const src = value as Record<string, unknown>;
  const isObject = typeof value === "object" && value !== null;
  const responseHeaders: Record<string, string> = {};
  const contentType = variant.contentType ?? defaultContentTypeForKind(variant.kind);
  if (contentType) responseHeaders["content-type"] = contentType;

  if (isObject) {
    for (const [property, header] of variant.headers ?? []) {
      const v = src[property];
      if (v !== undefined && (typeof v !== "object" || v === null)) {
        responseHeaders[header] = String(v);
      }
    }
  }

  const body = resolveVariantBody(value, src, isObject, variant);

  if (variant.kind === "text") {
    return new Response(String(body ?? ""), {
      status: variant.status,
      headers: responseHeaders,
    });
  }

  if (variant.kind === "bytes") {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array();
    return new Response(new Uint8Array(bytes).buffer, {
      status: variant.status,
      headers: responseHeaders,
    });
  }

  return new Response(JSON.stringify(body), {
    status: variant.status,
    headers: responseHeaders,
  });
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

function omitVariantProperties(
  src: Record<string, unknown>,
  variant: ResponseVariant,
): unknown {
  const omit = new Set<string>(variant.omit ?? []);
  for (const [property] of variant.headers ?? []) {
    omit.add(property);
  }

  if (omit.size === 0) return src;

  const body: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    if (!omit.has(key)) body[key] = src[key];
  }
  return body;
}

function defaultContentTypeForKind(kind: ResponseVariant["kind"]): string | undefined {
  switch (kind) {
    case "text":
      return "text/plain; charset=utf-8";
    case "bytes":
      return "application/octet-stream";
    case "json":
    case undefined:
      return "application/json";
    default:
      return undefined;
  }
}

function variantResponseEncoder<A>(
  variant: ResponseVariant,
): ResponseEncoder<A> {
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

export const ResponseEncoders = {
  json: jsonResponseEncoder,
  jsonWithHeaders: jsonWithHeadersResponseEncoder,
  empty: emptyResponseEncoder,
  text: textResponseEncoder,
  bytes: bytesResponseEncoder,
  stream: streamResponseEncoder,
  response: rawResponseEncoder,
  variant: variantResponseEncoder,
  matchVariant: matchVariantResponseEncoder,
  unreachable: unreachableResponse,
} as const;
