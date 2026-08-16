import type { Either as EitherT } from "../core/either.js";
import { Either, isLeft } from "../core/either.js";
import { getSearchParams } from "./query-params.js";
import { parseMediaType } from "./media-type.js";
import {
  type BodyDecodeError,
  type BodyDecoderMap,
  type BodyDecodeOptions,
  type DecoderResult,
  type JsonlBodyDecodeOptions,
  Decoder,
  decodeBody,
  decodeJsonBody,
  decodeJsonlBody,
  decodeMultipartBody,
  fail,
  prefixIssues,
  traverseEither,
} from "./decoder.js";
import { type ValidationIssue, ValidationError } from "./validation.js";

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

export interface PathParameterDecodeOptions extends RequestParameterDecodeOptions {
  /** Raw separator for array-valued path captures. Defaults to a comma. */
  readonly arraySeparator?: string;
  /** Decode an RFC 6570 record: alternating components normally, or key=value entries when exploded. */
  readonly record?: boolean;
  /** Raw separator between record components. Defaults to a comma. */
  readonly recordSeparator?: string;
  /** Treat an omitted RFC 6570 composite expansion as empty and reject an explicit empty capture. */
  readonly emptyComposite?: boolean;
}

export interface QueryParameterDecodeOptions extends RequestParameterDecodeOptions {
  /** Decode an RFC 6570 associative composite from one named value or exploded query entries. */
  readonly record?: boolean;
  /** Treat an omitted composite as empty; for named records, reject an explicit empty value. */
  readonly emptyComposite?: boolean;
  /** The decoded query names owned by a finite exploded object. */
  readonly includedNames?: readonly string[];
  /** Query names owned by other parameters and excluded from an exploded record. */
  readonly excludedNames?: readonly string[];
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
  options: PathParameterDecodeOptions = {},
): RequestDecoder<A> {
  if (options.array && options.record) {
    throw new TypeError("Path parameters cannot use array and record decoding together.");
  }
  if (options.arraySeparator !== undefined && !options.array) {
    throw new TypeError("Path array separators require array decoding.");
  }
  if (options.arraySeparator === "") {
    throw new TypeError("Path array separators must not be empty.");
  }
  if (options.recordSeparator !== undefined && !options.record) {
    throw new TypeError("Path record separators require record decoding.");
  }
  if (options.recordSeparator === "") {
    throw new TypeError("Path record separators must not be empty.");
  }
  if (options.emptyComposite && !options.array && !options.record) {
    throw new TypeError("Empty path composite handling requires array or record decoding.");
  }
  const arraySeparator = options.arraySeparator ?? ",";
  const recordSeparator = options.recordSeparator ?? ",";
  const prefix = `$path.${name}`;
  return createRequestDecoder((input) => {
    const raw = input.pathParams[name];
    const decodedValue: DecoderResult<string | string[] | Record<string, string>> | undefined =
      options.emptyComposite && raw === undefined
        ? options.record
          ? decodeDelimitedRecord("", recordSeparator, options.explode === true, uriDecode)
          : Either.right([])
        : options.emptyComposite && raw === ""
          ? fail("", "Expected an empty composite path expansion to be omitted.")
          : raw === undefined
            ? undefined
            : options.record
              ? decodeDelimitedRecord(raw, recordSeparator, options.explode === true, uriDecode)
              : options.array
                ? uriDecodeArray(raw.split(arraySeparator))
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
  options: QueryParameterDecodeOptions = {},
): RequestDecoder<A> {
  if (options.array && options.record) {
    throw new TypeError("Query parameters cannot use array and record decoding together.");
  }
  if (options.emptyComposite && !options.record) {
    throw new TypeError("Empty query composite handling requires record decoding.");
  }
  if (
    (options.includedNames !== undefined || options.excludedNames !== undefined) &&
    (!options.record || options.explode !== true)
  ) {
    throw new TypeError("Query name selection requires exploded record decoding.");
  }
  if (options.includedNames !== undefined && options.excludedNames !== undefined) {
    throw new TypeError("Exploded query decoding cannot combine included and excluded names.");
  }
  const includedNames =
    options.includedNames === undefined ? undefined : new Set(options.includedNames);
  const excludedNames = new Set(options.excludedNames ?? []);
  const prefix = `$query.${name}`;
  return createRequestDecoder((input) => {
    const value = readQueryValue(input, name, options, includedNames, excludedNames);
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
      raw === null
        ? undefined
        : options.mediaType
          ? (parseMediaType(raw) ?? raw)
          : options.array
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

  return Either.map(mergeRequestAndBodyResults(requestResult, bodyResult), (value) =>
    mirrorFileNameMetadata(value, options),
  );
}

/**
 * Decodes request parameters and attaches a lazy JSONL item stream under one
 * collision-free handler property.
 *
 * Boundary errors from the body retain precedence over parameter validation.
 * When both boundaries produce validation issues, they are accumulated before
 * the handler runs. Record-level JSONL failures still surface during iteration.
 */
export function decodeRequestInputAndJsonlBody<A extends object, B, P extends string>(
  requestDecoder: RequestDecoder<A>,
  bodyDecoder: Decoder<B>,
  bodyProperty: P,
  request: Request,
  pathParams: Readonly<Record<string, string>>,
  options: JsonlBodyDecodeOptions = {},
): EitherT<BodyDecodeError, A & Readonly<Record<P, AsyncIterable<B>>>> {
  const requestResult = requestDecoder.decode(createRequestInputSource(request, pathParams));
  const bodyResult = decodeJsonlBody(request, bodyDecoder, { ...options, root: "$body" });

  if (isLeft(bodyResult) && !(bodyResult.left instanceof ValidationError)) {
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

  if (Object.prototype.hasOwnProperty.call(requestResult.right, bodyProperty)) {
    return Either.left(
      new ValidationError([
        {
          path: `$body.${bodyProperty}`,
          message: `Body property "${bodyProperty}" conflicts with another request input.`,
        },
      ]),
    );
  }

  return Either.right({
    ...requestResult.right,
    [bodyProperty]: bodyResult.right,
  } as A & Readonly<Record<P, AsyncIterable<B>>>);
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
  // HTTP body-policy errors (such as 413 and 415) take precedence because the
  // body was intentionally not decoded and cannot contribute validation issues.
  if (isLeft(bodyResult) && !(bodyResult.left instanceof ValidationError)) {
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

  const body = bodyResult.right;
  if (body !== undefined) {
    const collisions = Object.keys(body).filter((key) =>
      Object.prototype.hasOwnProperty.call(requestResult.right, key),
    );
    if (collisions.length > 0) {
      return Either.left(
        new ValidationError(
          collisions.map((key) => ({
            path: `$body.${key}`,
            message: `Body property "${key}" conflicts with another request input.`,
          })),
        ),
      );
    }
  }

  return Either.right({
    ...requestResult.right,
    ...(body ?? {}),
  } as MergedRequestInput<A, B, boolean>);
}

function mirrorFileNameMetadata<A extends object>(value: A, options: BodyDecodeOptions): A {
  const nameProperty = options.fileNameProperty;
  const bodyProperty = options.fileBodyProperty;
  if (!nameProperty || !bodyProperty) return value;

  const input = value as Record<string, unknown>;
  const filename = input[nameProperty];
  const file = input[bodyProperty];
  if (typeof filename !== "string" || !(file instanceof File) || file.name === filename) {
    return value;
  }

  const renamed = new File([file], filename, {
    type: file.type,
    lastModified: file.lastModified,
  });
  // Normalize runtimes that alter otherwise-valid empty names or media types.
  if (renamed.name !== filename) {
    Object.defineProperty(renamed, "name", { value: filename, enumerable: true });
  }
  if (renamed.type !== file.type) {
    Object.defineProperty(renamed, "type", { value: file.type, enumerable: true });
  }

  return { ...input, [bodyProperty]: renamed } as A;
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
  input: RequestInputSource,
  name: string,
  options: QueryParameterDecodeOptions,
  includedNames: ReadonlySet<string> | undefined,
  excludedNames: ReadonlySet<string>,
): DecoderResult<string | readonly string[] | Record<string, string> | undefined> {
  if (options.record && options.explode === true) {
    return input.rawQuery === undefined
      ? readExplodedQueryRecord(
          input.query,
          includedNames,
          excludedNames,
          options.emptyComposite === true,
        )
      : readRawExplodedQueryRecord(
          input.rawQuery,
          includedNames,
          excludedNames,
          options.emptyComposite === true,
        );
  }
  if (input.rawQuery !== undefined) {
    return readRawQueryValue(input.rawQuery, name, options);
  }
  const query = input.query;
  if (!query.has(name)) {
    return options.record && options.emptyComposite ? Either.right({}) : Either.right(undefined);
  }
  if (options.record) {
    const values = query.getAll(name);
    if (values.length > 1) {
      return fail("", "Expected one comma-delimited query record parameter.");
    }
    const value = values[0]!;
    if (options.emptyComposite && value === "") {
      return fail("", "Expected an empty composite query expansion to be omitted.");
    }
    return decodeDelimitedRecord(value, ",", false, decodedQueryComponent);
  }
  if (options.array && options.explode === false) {
    if (query.getAll(name).length > 1) {
      return fail("", "Expected one comma-delimited query parameter.");
    }
    return Either.right(splitCommaSeparated(query.get(name)!));
  }
  const values = query.getAll(name);
  if (options.array) return Either.right(values);
  return Either.right(values.length === 1 ? values[0] : values);
}

function readRawQueryValue(
  rawQuery: string,
  name: string,
  options: QueryParameterDecodeOptions,
): DecoderResult<string | readonly string[] | Record<string, string> | undefined> {
  const rawValues: string[] = [];
  for (const pair of rawQuery.split("&")) {
    const equals = pair.indexOf("=");
    const rawName = equals === -1 ? pair : pair.substring(0, equals);
    const decodedName = decodeQueryComponent(rawName);
    if (isLeft(decodedName) || decodedName.right !== name) continue;
    rawValues.push(equals === -1 ? "" : pair.substring(equals + 1));
  }

  if (rawValues.length === 0) {
    return options.record && options.emptyComposite ? Either.right({}) : Either.right(undefined);
  }
  if (options.record) {
    if (rawValues.length > 1) {
      return fail("", "Expected one comma-delimited query record parameter.");
    }
    const rawValue = rawValues[0]!;
    if (options.emptyComposite && rawValue === "") {
      return fail("", "Expected an empty composite query expansion to be omitted.");
    }
    return decodeDelimitedRecord(rawValue, ",", false, decodeQueryComponent);
  }
  if (options.array && options.explode === false) {
    if (rawValues.length > 1) {
      return fail("", "Expected one comma-delimited query parameter.");
    }
    return traverseEither(rawValues[0]!.split(","), (item, index) => {
      const decoded = decodeQueryComponent(item);
      if (isLeft(decoded)) return prefixIssues(decoded, `[${index}]`);
      return Either.right(decoded.right.trim());
    });
  }

  const values = traverseEither<string, string>(rawValues, (rawValue, index) => {
    const decoded = decodeQueryComponent(rawValue);
    if (isLeft(decoded) && options.array) return prefixIssues(decoded, `[${index}]`);
    return decoded;
  });
  if (isLeft(values)) return values;
  if (options.array) return values;
  return Either.right(values.right.length === 1 ? values.right[0] : values.right);
}

function readExplodedQueryRecord(
  query: URLSearchParams,
  includedNames: ReadonlySet<string> | undefined,
  excludedNames: ReadonlySet<string>,
  emptyComposite: boolean,
): DecoderResult<Record<string, string> | undefined> {
  const result: Record<string, string> = {};
  let ownedEntry = false;
  let index = 0;
  for (const [key, value] of query.entries()) {
    const path = `[${index}]`;
    index += 1;
    if (!ownsExplodedQueryName(key, includedNames, excludedNames)) continue;
    ownedEntry = true;
    const defined = defineRecordEntry(result, key, value, path);
    if (isLeft(defined)) return defined;
  }
  return Either.right(
    includedNames !== undefined && !ownedEntry && !emptyComposite ? undefined : result,
  );
}

function readRawExplodedQueryRecord(
  rawQuery: string,
  includedNames: ReadonlySet<string> | undefined,
  excludedNames: ReadonlySet<string>,
  emptyComposite: boolean,
): DecoderResult<Record<string, string> | undefined> {
  const result: Record<string, string> = {};
  if (rawQuery === "") {
    return Either.right(includedNames !== undefined && !emptyComposite ? undefined : result);
  }

  let ownedEntry = false;
  let index = 0;
  for (const pair of rawQuery.split("&")) {
    const path = `[${index}]`;
    index += 1;
    if (pair === "") continue;

    const equals = pair.indexOf("=");
    const rawKey = equals === -1 ? pair : pair.substring(0, equals);
    const rawValue = equals === -1 ? "" : pair.substring(equals + 1);
    const key = decodeQueryComponent(rawKey);
    if (isLeft(key)) {
      if (includedNames !== undefined) continue;
      return prefixIssues(key, `${path}.key`);
    }
    if (!ownsExplodedQueryName(key.right, includedNames, excludedNames)) continue;
    ownedEntry = true;
    const value = decodeQueryComponent(rawValue);
    if (isLeft(value)) return prefixIssues(value, `${path}.value`);
    const defined = defineRecordEntry(result, key.right, value.right, path);
    if (isLeft(defined)) return defined;
  }

  return Either.right(
    includedNames !== undefined && !ownedEntry && !emptyComposite ? undefined : result,
  );
}

function ownsExplodedQueryName(
  name: string,
  includedNames: ReadonlySet<string> | undefined,
  excludedNames: ReadonlySet<string>,
): boolean {
  return includedNames === undefined ? !excludedNames.has(name) : includedNames.has(name);
}

function decodeQueryComponent(value: string): DecoderResult<string> {
  try {
    return Either.right(decodeURIComponent(value.replaceAll("+", " ")));
  } catch {
    return fail("", "Expected a valid percent-encoded query value.");
  }
}

function decodedQueryComponent(value: string): DecoderResult<string> {
  return Either.right(value);
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

function decodeDelimitedRecord(
  raw: string,
  separator: string,
  exploded: boolean,
  decodeComponent: (value: string) => DecoderResult<string>,
): DecoderResult<Record<string, string>> {
  const result: Record<string, string> = {};
  if (raw === "") return Either.right(result);

  const components = raw.split(separator);
  if (!exploded && components.length % 2 !== 0) {
    return fail(
      "",
      `Expected alternating record keys and values separated by ${JSON.stringify(separator)}.`,
    );
  }

  const entries: Array<readonly [string, string, number]> = [];
  if (exploded) {
    for (let index = 0; index < components.length; index += 1) {
      const component = components[index]!;
      const equals = component.indexOf("=");
      if (equals === -1) {
        return fail(`[${index}]`, "Expected an exploded record entry in key=value form.");
      }
      entries.push([component.slice(0, equals), component.slice(equals + 1), index]);
    }
  } else {
    for (let index = 0; index < components.length; index += 2) {
      entries.push([components[index]!, components[index + 1]!, index]);
    }
  }

  for (const [rawKey, rawValue, componentIndex] of entries) {
    const key = decodeComponent(rawKey);
    if (isLeft(key)) return prefixIssues(key, `[${componentIndex}]`);
    const value = decodeComponent(rawValue);
    if (isLeft(value)) {
      return prefixIssues(value, exploded ? `[${componentIndex}]` : `[${componentIndex + 1}]`);
    }
    const defined = defineRecordEntry(result, key.right, value.right, `[${componentIndex}]`);
    if (isLeft(defined)) return defined;
  }

  return Either.right(result);
}

function defineRecordEntry(
  result: Record<string, string>,
  key: string,
  value: string,
  path: string,
): DecoderResult<void> {
  if (Object.prototype.hasOwnProperty.call(result, key)) {
    return fail(path, `Duplicate record key ${JSON.stringify(key)}.`);
  }
  Object.defineProperty(result, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
  return Either.right(undefined);
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
