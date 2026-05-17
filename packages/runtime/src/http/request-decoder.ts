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

/** Request data available to path/query/header decoders. */
export interface RequestInputSource {
  readonly pathParams: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly headers: Headers;
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

/** Builds a RequestInputSource with lazy query parsing — only allocated when a request decoder reads `.query`. */
function createRequestInputSource(
  request: Request,
  pathParams: Readonly<Record<string, string>>,
): RequestInputSource {
  let _query: URLSearchParams | undefined;
  return {
    pathParams,
    get query() { return (_query ??= getSearchParams(request.url)); },
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

// ---------------------------------------------------------------------------
// Namespace
// ---------------------------------------------------------------------------

export const RequestDecoders = {
  path: requiredPath,
  query: requiredQuery,
  header: requiredHeader,
  combine: combineRequestDecoders,
} as const;
