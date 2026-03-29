import type { Either as EitherT } from "../core/either.js";
import { Either, isLeft } from "../core/either.js";
import { getSearchParams } from "../http.js";
import {
  type Codec,
  type CodecResult,
  type ValidationIssue,
  ValidationError,
  decodeJsonBody,
  decodeOptional,
  decodeRequired,
  prefixIssues,
  toValidationResult,
} from "./codec.js";

/** Synchronous input available to field decoders (path, query, headers). */
export interface FieldDecoderInput {
  readonly pathParams: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly headers: Headers;
}

/** Synchronous decoder for extracting one request field from HTTP input. */
export interface FieldDecoder<A> {
  decode(input: FieldDecoderInput): CodecResult<A>;
}

// ---------------------------------------------------------------------------
// Type-level helpers
// ---------------------------------------------------------------------------

type FieldDecoderTuple = readonly FieldDecoder<unknown>[];

type DecodedTuple<TDecoders extends FieldDecoderTuple> = {
  [TKey in keyof TDecoders]: TDecoders[TKey] extends FieldDecoder<infer A> ? A : never;
};

// ---------------------------------------------------------------------------
// Field decoder constructors
// ---------------------------------------------------------------------------

/** Decodes one required path parameter using the given codec. */
export function requiredPath<A>(
  name: string,
  codec: Codec<A>,
): FieldDecoder<A> {
  const prefix = `$path.${name}`;
  return {
    decode(input) {
      const raw = input.pathParams[name];
      const value = raw === undefined ? undefined : uriDecode(raw);
      const result = decodeRequired(codec, value);
      return isLeft(result) ? prefixIssues(result, prefix) : result;
    },
  };
}

/** Decodes one required query parameter using the given codec. */
export function requiredQuery<A>(
  name: string,
  codec: Codec<A>,
): FieldDecoder<A> {
  const prefix = `$query.${name}`;
  return {
    decode(input) {
      const result = decodeRequired(codec, readQueryValue(input.query, name));
      return isLeft(result) ? prefixIssues(result, prefix) : result;
    },
  };
}

/** Decodes one optional query parameter using the given codec. */
export function optionalQuery<A>(
  name: string,
  codec: Codec<A>,
): FieldDecoder<A | undefined> {
  const prefix = `$query.${name}`;
  return {
    decode(input) {
      const result = decodeOptional(codec, readQueryValue(input.query, name));
      return isLeft(result) ? prefixIssues(result, prefix) : result;
    },
  };
}

/** Decodes one required header using the given codec. */
export function requiredHeader<A>(
  name: string,
  codec: Codec<A>,
): FieldDecoder<A> {
  const lower = name.toLowerCase();
  const prefix = `$header.${lower}`;
  return {
    decode(input) {
      const result = decodeRequired(codec, input.headers.get(lower));
      return isLeft(result) ? prefixIssues(result, prefix) : result;
    },
  };
}

/** Decodes one optional header using the given codec. */
export function optionalHeader<A>(
  name: string,
  codec: Codec<A>,
): FieldDecoder<A | undefined> {
  const lower = name.toLowerCase();
  const prefix = `$header.${lower}`;
  return {
    decode(input) {
      const result = decodeOptional(codec, input.headers.get(lower));
      return isLeft(result) ? prefixIssues(result, prefix) : result;
    },
  };
}

// ---------------------------------------------------------------------------
// Field decoder combinators
// ---------------------------------------------------------------------------

/** Maps the successful value of one field decoder. */
export function mapFieldDecoder<A, B>(
  decoder: FieldDecoder<A>,
  f: (value: A) => B,
): FieldDecoder<B> {
  return {
    decode(input) {
      const decoded = decoder.decode(input);
      return isLeft(decoded) ? decoded : Either.right(f(decoded.right));
    },
  };
}

/** Applicative combination of field decoders with synchronous error accumulation. */
export function mapNFields<TDecoders extends FieldDecoderTuple, A>(
  decoders: [...TDecoders],
  f: (...values: DecodedTuple<TDecoders>) => A,
): FieldDecoder<A> {
  return {
    decode(input) {
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

      return Either.right(f(...(values as DecodedTuple<TDecoders>)));
    },
  };
}

// ---------------------------------------------------------------------------
// Boundary functions — convert lightweight CodecResult to ValidationError
// ---------------------------------------------------------------------------

/**
 * Runs a sync field decoder against a request.
 * Returns Either<ValidationError, A> — wraps issues at the boundary.
 */
export function decodeFields<A>(
  decoder: FieldDecoder<A>,
  request: Request,
  pathParams: Readonly<Record<string, string>>,
): EitherT<ValidationError, A> {
  const result = decoder.decode(createFieldInput(request, pathParams));
  if (isLeft(result)) return Either.left(new ValidationError(result.left));
  return result;
}

/**
 * Decodes both sync fields and an async JSON body with error accumulation.
 * Returns Either<ValidationError, A & B> — wraps issues at the boundary.
 */
export async function decodeFieldsAndBody<
  A extends object,
  B extends object,
>(
  fieldDecoder: FieldDecoder<A>,
  bodyCodec: Codec<B>,
  request: Request,
  pathParams: Readonly<Record<string, string>>,
): Promise<EitherT<ValidationError, A & B>> {
  const fieldResult = fieldDecoder.decode(createFieldInput(request, pathParams));
  const bodyResult = await decodeJsonBody(request, bodyCodec, "$body");

  const fieldFailed = isLeft(fieldResult);
  const bodyFailed = isLeft(bodyResult);
  if (fieldFailed || bodyFailed) {
    const issues: ValidationIssue[] = [];
    if (fieldFailed) issues.push(...fieldResult.left);
    if (bodyFailed) issues.push(...bodyResult.left.issues);
    return Either.left(new ValidationError(issues));
  }

  return Either.right({ ...fieldResult.right, ...bodyResult.right } as A & B);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Builds a FieldDecoderInput with lazy query parsing — only allocated when a decoder reads `.query`. */
function createFieldInput(
  request: Request,
  pathParams: Readonly<Record<string, string>>,
): FieldDecoderInput {
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
