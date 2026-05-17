import type { Either as EitherT } from "../core/either.js";
import { Either, isLeft } from "../core/either.js";
import { getSearchParams } from "./query-params.js";
import {
  type DecoderResult,
  Decoder,
  decodeJsonBody,
  prefixIssues,
} from "./decoder.js";
import { type ValidationIssue, ValidationError } from "./validation.js";

/** Request data available to path/query/header/cookie decoders. */
export interface RequestInputSource {
  readonly pathParams: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly headers: Headers;
  readonly cookies: Readonly<Record<string, string>>;
}

export type RequestDecoder<A> = Decoder<A, RequestInputSource>;

// ---------------------------------------------------------------------------
// Type-level helpers
// ---------------------------------------------------------------------------

type RequestDecoderTuple = readonly RequestDecoder<unknown>[];

type RequestDecoderValues<TDecoders extends RequestDecoderTuple> = {
  [TKey in keyof TDecoders]: TDecoders[TKey] extends RequestDecoder<infer A> ? A : never;
};

// ---------------------------------------------------------------------------
// Request decoder constructors
// ---------------------------------------------------------------------------

function createRequestDecoder<A>(
  decode: (input: RequestInputSource) => DecoderResult<A>,
): RequestDecoder<A> {
  return Decoder.of(decode);
}

/** Decodes a path parameter. */
export function requiredPath<A>(
  name: string,
  decoder: Decoder<A>,
): RequestDecoder<A> {
  const prefix = `$path.${name}`;
  return createRequestDecoder((input) => {
    const raw = input.pathParams[name];
    const value = raw === undefined ? undefined : uriDecode(raw);
    const result = decoder.decode(value);
    return isLeft(result) ? prefixIssues(result, prefix) : result;
  });
}

/** Decodes a query parameter. */
export function requiredQuery<A>(
  name: string,
  decoder: Decoder<A>,
): RequestDecoder<A> {
  const prefix = `$query.${name}`;
  return createRequestDecoder((input) => {
    const result = decoder.decode(readQueryValue(input.query, name));
    return isLeft(result) ? prefixIssues(result, prefix) : result;
  });
}

/** Decodes a header. */
export function requiredHeader<A>(
  name: string,
  decoder: Decoder<A>,
): RequestDecoder<A> {
  const lower = name.toLowerCase();
  const prefix = `$header.${lower}`;
  return createRequestDecoder((input) => {
    const result = decoder.decode(input.headers.get(lower));
    return isLeft(result) ? prefixIssues(result, prefix) : result;
  });
}

/** Decodes a cookie. */
export function requiredCookie<A>(
  name: string,
  decoder: Decoder<A>,
): RequestDecoder<A> {
  const prefix = `$cookie.${name}`;
  return createRequestDecoder((input) => {
    const result = decoder.decode(input.cookies[name]);
    return isLeft(result) ? prefixIssues(result, prefix) : result;
  });
}

// ---------------------------------------------------------------------------
// Request decoder combinators
// ---------------------------------------------------------------------------

/** Applicative combination of request decoders with synchronous error accumulation. */
export function combineRequestDecoders<TDecoders extends RequestDecoderTuple, A>(
  decoders: [...TDecoders],
  f: (...values: RequestDecoderValues<TDecoders>) => A,
): RequestDecoder<A> {
  return createRequestDecoder((input) => {
      let issues: ValidationIssue[] | null = null;
      const values: unknown[] = [];

      for (const decoder of decoders) {
        const decoded = decoder.decode(input);
        if (isLeft(decoded)) {
          (issues ??= []).push(...decoded.left);
        } else {
          values.push(decoded.right);
        }
      }

      if (issues) {
        return Either.left(issues);
      }

      return Either.right(f(...(values as RequestDecoderValues<TDecoders>)));
  });
}

// ---------------------------------------------------------------------------
// Boundary functions — convert lightweight DecoderResult to ValidationError
// ---------------------------------------------------------------------------

/**
 * Runs a sync request decoder against a request.
 * Returns Either<ValidationError, A> — wraps issues at the boundary.
 */
export function decodeRequestInput<A>(
  decoder: RequestDecoder<A>,
  request: Request,
  pathParams: Readonly<Record<string, string>>,
): EitherT<ValidationError, A> {
  const result = decoder.decode(createRequestInputSource(request, pathParams));
  if (isLeft(result)) return Either.left(new ValidationError(result.left));
  return result;
}

/**
 * Decodes both sync request input and an async JSON body with error accumulation.
 * Returns Either<ValidationError, A & B> — wraps issues at the boundary.
 */
export async function decodeRequestInputAndBody<
  A extends object,
  B extends object,
>(
  requestDecoder: RequestDecoder<A>,
  bodyDecoder: Decoder<B>,
  request: Request,
  pathParams: Readonly<Record<string, string>>,
): Promise<EitherT<ValidationError, A & B>> {
  const requestResult = requestDecoder.decode(createRequestInputSource(request, pathParams));
  const bodyResult = await decodeJsonBody(request, bodyDecoder, "$body");

  const requestFailed = isLeft(requestResult);
  const bodyFailed = isLeft(bodyResult);
  if (requestFailed || bodyFailed) {
    const issues: ValidationIssue[] = [];
    if (requestFailed) issues.push(...requestResult.left);
    if (bodyFailed) issues.push(...bodyResult.left.issues);
    return Either.left(new ValidationError(issues));
  }

  return Either.right({ ...requestResult.right, ...bodyResult.right } as A & B);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Builds a RequestInputSource with lazy query/cookie parsing. */
function createRequestInputSource(
  request: Request,
  pathParams: Readonly<Record<string, string>>,
): RequestInputSource {
  let _query: URLSearchParams | undefined;
  let _cookies: Record<string, string> | undefined;
  return {
    pathParams,
    get query() { return (_query ??= getSearchParams(request.url)); },
    get cookies() { return (_cookies ??= parseCookies(request.headers.get("cookie"))); },
    headers: request.headers,
  };
}

function readQueryValue(
  query: URLSearchParams,
  name: string,
): string | readonly string[] | undefined {
  if (!query.has(name)) return undefined;
  const values = query.getAll(name);
  return values.length === 1 ? values[0] : values;
}

/** Fast-path URI decode: skip native call when no percent-encoding is present. */
function uriDecode(value: string): string {
  return value.indexOf("%") === -1 ? value : decodeURIComponent(value);
}

const EMPTY_COOKIES: Record<string, string> = Object.freeze(Object.create(null));

/** Parses a Cookie header into name→value pairs. */
function parseCookies(header: string | null): Record<string, string> {
  if (!header) return EMPTY_COOKIES;
  const cookies: Record<string, string> = Object.create(null);
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.substring(0, eq).trim();
    const value = pair.substring(eq + 1).trim();
    if (name) cookies[name] = value;
  }
  return cookies;
}

// ---------------------------------------------------------------------------
// Namespace
// ---------------------------------------------------------------------------

export const RequestDecoders = {
  path: requiredPath,
  query: requiredQuery,
  header: requiredHeader,
  cookie: requiredCookie,
  combine: combineRequestDecoders,
} as const;
