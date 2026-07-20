import type { Either as EitherT } from "../core/either.js";
import { Either, isLeft } from "../core/either.js";
import { getSearchParams } from "./query-params.js";
import { parseMediaType } from "./media-type.js";
import {
  type BodyDecodeError,
  type BodyDecoderMap,
  type BodyDecodeOptions,
  type DecoderResult,
  Decoder,
  decodeBody,
  decodeJsonBody,
  decodeMultipartBody,
  fail,
  prefixIssues,
  traverseEither,
} from "./decoder.js";
import { type ValidationIssue, UnsupportedMediaTypeError, ValidationError } from "./validation.js";

/** Request data available to path/query/header/cookie decoders. */
export interface RequestInputSource {
  readonly pathParams: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly rawQuery?: string;
  readonly headers: Headers;
  readonly cookies: Readonly<Record<string, string>>;
}

export interface RequestParameterDecodeOptions {
  readonly array?: boolean;
  readonly explode?: boolean;
  readonly mediaType?: boolean;
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
  options: RequestParameterDecodeOptions = {},
): RequestDecoder<A> {
  const prefix = `$path.${name}`;
  return createRequestDecoder((input) => {
    const raw = input.pathParams[name];
    const decodedValue: DecoderResult<string | string[]> | undefined =
      raw === undefined
        ? undefined
        : options.array
          ? uriDecodeArray(raw.split(","))
          : uriDecode(raw);
    if (decodedValue !== undefined && isLeft(decodedValue)) {
      return prefixIssues(decodedValue, prefix);
    }
    const value = decodedValue === undefined ? undefined : decodedValue.right;
    const result = decoder.decode(value);
    return isLeft(result) ? prefixIssues(result, prefix) : result;
  });
}

/** Decodes a query parameter. */
export function requiredQuery<A>(
  name: string,
  decoder: Decoder<A>,
  options: RequestParameterDecodeOptions = {},
): RequestDecoder<A> {
  const prefix = `$query.${name}`;
  return createRequestDecoder((input) => {
    if (options.array && options.explode === false && input.query.getAll(name).length > 1) {
      return fail(prefix, "Expected one comma-delimited query parameter.");
    }
    const value = readQueryValue(input.query, input.rawQuery, name, options);
    if (isLeft(value)) return prefixIssues(value, prefix);
    const result = decoder.decode(value.right);
    return isLeft(result) ? prefixIssues(result, prefix) : result;
  });
}

/** Decodes a header. */
export function requiredHeader<A>(
  name: string,
  decoder: Decoder<A>,
  options: RequestParameterDecodeOptions = {},
): RequestDecoder<A> {
  const lower = name.toLowerCase();
  const prefix = `$header.${lower}`;
  return createRequestDecoder((input) => {
    const raw = input.headers.get(lower);
    const value =
      raw !== null && options.mediaType
        ? (parseMediaType(raw) ?? raw)
        : raw !== null && options.array
          ? splitCommaSeparated(raw)
          : raw;
    const result = decoder.decode(value);
    return isLeft(result) ? prefixIssues(result, prefix) : result;
  });
}

/** Decodes a cookie. */
export function requiredCookie<A>(
  name: string,
  decoder: Decoder<A>,
  options: RequestParameterDecodeOptions = {},
): RequestDecoder<A> {
  const prefix = `$cookie.${name}`;
  return createRequestDecoder((input) => {
    const raw = input.cookies[name];
    const result = decoder.decode(
      raw !== undefined && options.array ? splitCommaSeparated(raw) : raw,
    );
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

/** Request parameters merged with a required or optional body object. */
export type MergedRequestInput<
  A extends object,
  B extends object,
  Optional extends boolean = false,
> = A & (Optional extends true ? Partial<B> : B);

function isDecoder<A>(candidate: Decoder<A> | BodyDecoderMap<A>): candidate is Decoder<A> {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    "decode" in candidate &&
    typeof candidate.decode === "function"
  );
}

/**
 * Decodes both sync request input and an async body with error accumulation.
 * If `options.contentTypes` is set, the request Content-Type is validated and
 * a 415 short-circuits without merging request input errors.
 */
export function decodeRequestInputAndBody<A extends object, B extends object>(
  requestDecoder: RequestDecoder<A>,
  bodyDecoder: Decoder<B> | BodyDecoderMap<B>,
  request: Request,
  pathParams: Readonly<Record<string, string>>,
  options: BodyDecodeOptions & { readonly optional: true },
): Promise<EitherT<BodyDecodeError, MergedRequestInput<A, B, true>>>;
export function decodeRequestInputAndBody<A extends object, B extends object>(
  requestDecoder: RequestDecoder<A>,
  bodyDecoder: Decoder<B> | BodyDecoderMap<B>,
  request: Request,
  pathParams: Readonly<Record<string, string>>,
  options?: BodyDecodeOptions & { readonly optional?: false },
): Promise<EitherT<BodyDecodeError, MergedRequestInput<A, B, false>>>;
export function decodeRequestInputAndBody<A extends object, B extends object>(
  requestDecoder: RequestDecoder<A>,
  bodyDecoder: Decoder<B> | BodyDecoderMap<B>,
  request: Request,
  pathParams: Readonly<Record<string, string>>,
  options: BodyDecodeOptions,
): Promise<EitherT<BodyDecodeError, MergedRequestInput<A, B, boolean>>>;
export async function decodeRequestInputAndBody<A extends object, B extends object>(
  requestDecoder: RequestDecoder<A>,
  bodyDecoder: Decoder<B> | BodyDecoderMap<B>,
  request: Request,
  pathParams: Readonly<Record<string, string>>,
  options: BodyDecodeOptions = {},
): Promise<EitherT<BodyDecodeError, MergedRequestInput<A, B, boolean>>> {
  const requestResult = requestDecoder.decode(createRequestInputSource(request, pathParams));
  const bodyResult = isDecoder(bodyDecoder)
    ? await decodeJsonBody(request, bodyDecoder, { ...options, root: "$body" })
    : await decodeBody(request, bodyDecoder, { ...options, root: "$body" });

  return mergeRequestAndBodyResults(requestResult, bodyResult);
}

/**
 * Decodes sync request input and an async multipart body with error accumulation.
 */
export async function decodeRequestInputAndMultipartBody<A extends object, B extends object>(
  requestDecoder: RequestDecoder<A>,
  bodyDecoder: Decoder<B>,
  request: Request,
  pathParams: Readonly<Record<string, string>>,
  options: BodyDecodeOptions = {},
): Promise<EitherT<BodyDecodeError, A & B>> {
  const requestResult = requestDecoder.decode(createRequestInputSource(request, pathParams));
  const bodyResult = await decodeMultipartBody(request, bodyDecoder, { ...options, root: "$body" });

  return mergeRequestAndBodyResults(requestResult, bodyResult);
}

function mergeRequestAndBodyResults<A extends object, B extends object>(
  requestResult: DecoderResult<A>,
  bodyResult: EitherT<BodyDecodeError, B>,
): EitherT<BodyDecodeError, MergedRequestInput<A, B, false>>;
function mergeRequestAndBodyResults<A extends object, B extends object>(
  requestResult: DecoderResult<A>,
  bodyResult: EitherT<BodyDecodeError, B | undefined>,
): EitherT<BodyDecodeError, MergedRequestInput<A, B, boolean>>;
function mergeRequestAndBodyResults<A extends object, B extends object>(
  requestResult: DecoderResult<A>,
  bodyResult: EitherT<BodyDecodeError, B | undefined>,
): EitherT<BodyDecodeError, MergedRequestInput<A, B, boolean>> {
  // 415 takes precedence: a wrong Content-Type means we cannot trust the body
  // shape, so request-input errors are not merged in.
  if (isLeft(bodyResult) && bodyResult.left instanceof UnsupportedMediaTypeError) {
    return Either.left(bodyResult.left);
  }

  const requestFailed = isLeft(requestResult);
  const bodyFailed = isLeft(bodyResult);
  if (requestFailed || bodyFailed) {
    const issues: ValidationIssue[] = [];
    if (requestFailed) issues.push(...requestResult.left);
    if (bodyFailed) issues.push(...(bodyResult.left as ValidationError).issues);
    return Either.left(new ValidationError(issues));
  }

  return Either.right({
    ...requestResult.right,
    ...(bodyResult.right ?? {}),
  } as MergedRequestInput<A, B, boolean>);
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
    get query() {
      return (_query ??= getSearchParams(request.url));
    },
    rawQuery: extractRawQuery(request.url),
    get cookies() {
      return (_cookies ??= parseCookies(request.headers.get("cookie")));
    },
    headers: request.headers,
  };
}

function readQueryValue(
  query: URLSearchParams,
  rawQuery: string | undefined,
  name: string,
  options: RequestParameterDecodeOptions,
): DecoderResult<string | readonly string[] | undefined> {
  if (!query.has(name)) return Either.right(undefined);
  if (options.array && options.explode === false) {
    const rawValue = readDelimitedRawQueryValue(rawQuery, name);
    if (isLeft(rawValue)) return rawValue;
    return Either.right(rawValue.right ?? splitCommaSeparated(query.get(name)!));
  }
  const values = query.getAll(name);
  if (options.array) return Either.right(values);
  return Either.right(values.length === 1 ? values[0] : values);
}

function readDelimitedRawQueryValue(
  rawQuery: string | undefined,
  name: string,
): DecoderResult<readonly string[] | undefined> {
  if (rawQuery === undefined) return Either.right(undefined);
  for (const pair of rawQuery.split("&")) {
    const equals = pair.indexOf("=");
    const rawName = equals === -1 ? pair : pair.substring(0, equals);
    const decodedName = decodeQueryComponent(rawName);
    if (isLeft(decodedName) || decodedName.right !== name) continue;
    const rawValue = equals === -1 ? "" : pair.substring(equals + 1);
    return traverseEither(rawValue.split(","), (item, index) => {
      const decoded = decodeQueryComponent(item);
      if (isLeft(decoded)) return prefixIssues(decoded, `[${index}]`);
      return Either.right(decoded.right.trim());
    });
  }
  return Either.right(undefined);
}

function decodeQueryComponent(value: string): DecoderResult<string> {
  try {
    return Either.right(decodeURIComponent(value.replaceAll("+", " ")));
  } catch {
    return fail("", "Expected a valid percent-encoded query value.");
  }
}

function splitCommaSeparated(value: string): string[] {
  return value.split(",").map((item) => item.trim());
}

function extractRawQuery(url: string): string | undefined {
  const question = url.indexOf("?");
  if (question === -1) return undefined;
  const hash = url.indexOf("#", question + 1);
  return url.substring(question + 1, hash === -1 ? url.length : hash);
}

/** Fast-path URI decode: skip native call when no percent-encoding is present. */
function uriDecode(value: string): DecoderResult<string> {
  if (value.indexOf("%") === -1) return Either.right(value);
  try {
    return Either.right(decodeURIComponent(value));
  } catch {
    return fail("", "Expected a valid percent-encoded path segment.");
  }
}

function uriDecodeArray(values: readonly string[]): DecoderResult<string[]> {
  return traverseEither(values, (value, index) => {
    const decoded = uriDecode(value);
    return isLeft(decoded) ? prefixIssues(decoded, `[${index}]`) : decoded;
  });
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
