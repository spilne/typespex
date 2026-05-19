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

export interface ResponseVariant {
  readonly status: number;
  readonly kind?: "json" | "text" | "bytes" | "empty";
  readonly headers?: ReadonlyArray<readonly [property: string, header: string]>;
  readonly body?: string;
  readonly omit?: readonly string[];
  readonly contentType?: string;
}

export type ResponseMatcher =
  | {
      readonly kind: "undefined";
      readonly variant: ResponseVariant;
    }
  | {
      readonly kind: "array";
      readonly variant: ResponseVariant;
    }
  | {
      readonly kind: "type";
      readonly type: "string" | "number" | "boolean";
      readonly variant: ResponseVariant;
    }
  | {
      readonly kind: "object";
      readonly variant: ResponseVariant;
    }
  | {
      readonly kind: "field";
      readonly field: string;
      readonly cases: Readonly<Record<string, ResponseVariant>>;
    }
  | {
      readonly kind: "property";
      readonly cases: Readonly<Record<string, ResponseVariant>>;
    };

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
  const contentType = variant.contentType ??
    (variant.kind === "json" || variant.kind === undefined ? "application/json" : undefined);
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

function variantResponseEncoder<A>(
  variant: ResponseVariant,
): ResponseEncoder<A> {
  return ResponseEncoder.of((value) => encodeVariantResponse(value, variant));
}

function oneOfResponseEncoder<A>(
  matchers: readonly ResponseMatcher[],
): ResponseEncoder<A> {
  return ResponseEncoder.of((value) => {
    const variant = matchResponseVariant(value, matchers);
    if (!variant) {
      throw new TypeError("Result value did not match any declared HTTP response variant.");
    }
    return encodeVariantResponse(value, variant);
  });
}

function matchResponseVariant<A>(
  value: A,
  matchers: readonly ResponseMatcher[],
): ResponseVariant | undefined {
  for (const matcher of matchers) {
    if (matcher.kind === "undefined") {
      if (value === undefined) return matcher.variant;
      continue;
    }

    if (matcher.kind === "array") {
      if (Array.isArray(value)) return matcher.variant;
      continue;
    }

    if (matcher.kind === "type") {
      if (typeof value === matcher.type) return matcher.variant;
      continue;
    }

    if (typeof value !== "object" || value === null) continue;
    if (matcher.kind === "object") return matcher.variant;

    const obj = value as Record<string, unknown>;

    if (matcher.kind === "field") {
      const tag = obj[matcher.field];
      const key = typeof tag === "string" || typeof tag === "number" ? String(tag) : undefined;
      if (key !== undefined && matcher.cases[key]) return matcher.cases[key];
      continue;
    }

    for (const [property, variant] of Object.entries(matcher.cases)) {
      if (property in obj) return variant;
    }
  }

  return undefined;
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
  oneOf: oneOfResponseEncoder,
} as const;
