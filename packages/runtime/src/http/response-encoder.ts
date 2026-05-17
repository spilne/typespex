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

/**
 * JSON response encoder that extracts named properties as HTTP headers.
 * Properties listed in `headers` are set as response headers and removed from the body.
 */
function jsonWithHeadersResponseEncoder<A>(
  status: number,
  headers: ReadonlyArray<readonly [property: string, header: string]>,
): ResponseEncoder<A> {
  return ResponseEncoder.of((value) => {
    const obj = { ...(value as Record<string, unknown>) };
    const h = new Headers({ "content-type": "application/json" });
    for (const [prop, header] of headers) {
      if (prop in obj) {
        h.set(header, String(obj[prop]));
        delete obj[prop];
      }
    }
    return new Response(JSON.stringify(obj), { status, headers: h });
  });
}

export const ResponseEncoders = {
  json: jsonResponseEncoder,
  jsonWithHeaders: jsonWithHeadersResponseEncoder,
  empty: emptyResponseEncoder,
  text: textResponseEncoder,
  bytes: bytesResponseEncoder,
  response: rawResponseEncoder,
} as const;

// ---------------------------------------------------------------------------
// Error encoders — data-driven error → Response mapping
// ---------------------------------------------------------------------------

/** Single-status JSON error encoder. */
function jsonErrorEncoder<E>(status: number): ResponseEncoder<E> {
  return jsonResponseEncoder(status);
}

/** Discriminated by a field with unique literal values per variant. */
function discriminatedErrorEncoder<E>(
  field: string,
  variants: Readonly<Record<string, number>>,
  fallbackStatus = 500,
): ResponseEncoder<E> {
  return ResponseEncoder.of((error) => {
    const tag = (error as Record<string, unknown>)[field];
    const status = (typeof tag === "string" || typeof tag === "number"
      ? variants[String(tag)]
      : undefined) ?? fallbackStatus;
    return Response.json(error, { status });
  });
}

/** Discriminated by unique property existence per variant. */
function byPropertyErrorEncoder<E>(
  mapping: Readonly<Record<string, number>>,
  fallbackStatus = 500,
): ResponseEncoder<E> {
  const entries = Object.entries(mapping);
  return ResponseEncoder.of((error) => {
    const obj = error as Record<string, unknown>;
    for (const [prop, status] of entries) {
      if (prop in obj) return Response.json(error, { status });
    }
    return Response.json(error, { status: fallbackStatus });
  });
}

export const ErrorEncoders = {
  /** Single-status — no discrimination needed. */
  json: jsonErrorEncoder,
  /** Discriminated by a field with unique literal values. */
  discriminated: discriminatedErrorEncoder,
  /** Discriminated by unique property existence. */
  byProperty: byPropertyErrorEncoder,
} as const;
