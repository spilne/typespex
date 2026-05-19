import { Either, isLeft, type Either as EitherT } from "../core/either.js";
import { type ValidationIssue, type Validator, ValidationError, Validators } from "./validation.js";

/** Internal decoder result — lightweight issue array, no Error allocation. */
export type DecoderResult<A> = EitherT<readonly ValidationIssue[], A>;

/**
 * Runtime decoder that validates one input value into `A`.
 *
 * Decoders are path-free: errors carry relative path segments (e.g. `""`,
 * `".field"`, `"[0]"`).  Boundary functions prefix a root such as `"$"`.
 *
 * Returns `Either<ValidationIssue[], A>` — lightweight arrays, no Error objects.
 * Only boundary functions (`decode`, `decodeJsonBody`) wrap in `ValidationError`.
 */
export abstract class Decoder<A, Input = unknown> {
  abstract decode(input: Input): DecoderResult<A>;

  static of<A, Input = unknown>(decode: (input: Input) => DecoderResult<A>): Decoder<A, Input> {
    return new FnDecoder(decode);
  }

  map<B>(f: (value: A) => B): Decoder<B, Input> {
    return Decoder.of((input: Input) => Either.map(this.decode(input), f));
  }

  refine(
    predicate: (value: A) => boolean,
    message: string | ((value: A) => string),
  ): Decoder<A, Input> {
    return this.validate(Validators.refine(predicate, message));
  }

  validate(...validators: readonly Validator<A>[]): Decoder<A, Input> {
    if (validators.length === 0) return this;

    return Decoder.of((input: Input) => {
      return Either.flatMap(this.decode(input), (value) => {
        let issues: ValidationIssue[] | null = null;
        for (const validator of validators) {
          const validated = validator.validate(value);
          if (validated.length > 0) {
            (issues ??= []).push(...validated);
          }
        }
        return issues ? Either.left(issues) : succeed(value);
      });
    });
  }

  optional(): Decoder<A | undefined, Input | undefined> {
    return Decoder.of((input: Input | undefined) => {
      if (input === undefined) return RIGHT_UNDEF as DecoderResult<A | undefined>;
      return this.decode(input);
    });
  }
}

class FnDecoder<A, Input> extends Decoder<A, Input> {
  constructor(private readonly decodeFn: (input: Input) => DecoderResult<A>) {
    super();
  }
  decode(input: Input): DecoderResult<A> {
    return this.decodeFn(input);
  }
}

type TupleDecoderItems<A extends readonly unknown[]> = {
  readonly [K in keyof A]: Decoder<A[K]>;
};

type ObjectDecoderFields<A extends object> = {
  readonly [K in keyof A]-?: Decoder<A[K]>;
};

/** Decoder combinator for optional values. Accepts `undefined` (absent fields), delegates the rest. */
export function optional<A, Input = unknown>(
  decoder: Decoder<A, Input>,
): Decoder<A | undefined, Input | undefined> {
  return decoder.optional();
}

// ---------------------------------------------------------------------------
// Pre-allocated constants — avoid allocations on the hot path
// ---------------------------------------------------------------------------

const RIGHT_TRUE: DecoderResult<boolean> = Either.right(true);
const RIGHT_FALSE: DecoderResult<boolean> = Either.right(false);
const RIGHT_NULL: DecoderResult<null> = Either.right(null);
const RIGHT_UNDEF: DecoderResult<undefined> = Either.right(undefined);

// ---------------------------------------------------------------------------
// Decode result helpers — work with raw issue arrays, no Error allocation
// ---------------------------------------------------------------------------

/** Wraps a decoded value in a successful result. */
export function succeed<A>(value: A): DecoderResult<A> {
  return Either.right(value);
}

/** Creates a single-issue failure with a relative path. */
export function fail(path: string, message: string): DecoderResult<never> {
  return Either.left([{ path, message }]);
}

/** Creates a multi-issue failure. */
function failMany(issues: readonly ValidationIssue[]): DecoderResult<never> {
  return Either.left(issues);
}

function expectPlainObject(
  input: unknown,
): DecoderResult<Record<string, unknown>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail("", "Expected an object.");
  }
  return succeed(input as Record<string, unknown>);
}

/** Prefix every issue path in a Left with `prefix`. Identity on Right. */
export function prefixIssues<A>(
  either: DecoderResult<A>,
  prefix: string,
): DecoderResult<A> {
  if (!isLeft(either)) return either;
  return Either.left(
    either.left.map((i) => ({ path: prefix + i.path, message: i.message })),
  );
}

/**
 * Traverse an array with a decoding function, accumulating all errors.
 * Keeps the fast mutable accumulation internally while exposing a pure API.
 */
export function traverseEither<A, B>(
  items: readonly A[],
  f: (item: A, index: number) => DecoderResult<B>,
): DecoderResult<B[]> {
  const results: B[] = [];
  let issues: ValidationIssue[] | null = null;
  for (let i = 0; i < items.length; i++) {
    const decoded = f(items[i], i);
    if (isLeft(decoded)) {
      (issues ??= []).push(...decoded.left);
    } else {
      results.push(decoded.right);
    }
  }
  return issues ? failMany(issues) : succeed(results);
}

// ---------------------------------------------------------------------------
// Primitive decoders
// ---------------------------------------------------------------------------

const stringDecoder: Decoder<string> = Decoder.of((input) => {
    if (typeof input === "string") return succeed(input);
    return fail("", "Expected a string.");
});

const numberDecoder: Decoder<number> = Decoder.of((input) => {
    if (typeof input === "number" && Number.isFinite(input)) return succeed(input);
    if (typeof input === "string") {
      const parsed = Number(input);
      if (Number.isFinite(parsed)) return succeed(parsed);
    }
    return fail("", "Expected a finite number.");
});

const bigintDecoder: Decoder<bigint> = Decoder.of((input) => {
    if (typeof input === "bigint") return succeed(input);
    if (typeof input === "number" && Number.isInteger(input)) return succeed(BigInt(input));
    if (typeof input === "string") {
      try {
        return succeed(BigInt(input));
      } catch {
        return fail("", "Expected a valid integer.");
      }
    }
    return fail("", "Expected a valid integer.");
});

const booleanDecoder: Decoder<boolean> = Decoder.of((input) => {
    if (input === true) return RIGHT_TRUE;
    if (input === false) return RIGHT_FALSE;
    if (input === "true") return RIGHT_TRUE;
    if (input === "false") return RIGHT_FALSE;
    return fail("", 'Expected "true" or "false".');
});

const bytesDecoder: Decoder<Uint8Array> = Decoder.of((input) => {
    if (input instanceof Uint8Array) return succeed(input);
    if (typeof input === "string") return decodeBase64(input);
    if (Array.isArray(input)) return decodeByteArray(input);
    return fail("", "Expected a base64 string or byte array.");
});

const fileDecoder: Decoder<File> = Decoder.of((input) => {
    if (input instanceof File) return succeed(input);
    return fail("", "Expected a file.");
});

const unknownDecoder: Decoder<unknown> = Decoder.of((input) => {
    return succeed(input);
});

// ---------------------------------------------------------------------------
// Combinator decoders
// ---------------------------------------------------------------------------

function literalDecoder<A extends string | number | boolean | null>(
  value: A,
): Decoder<A> {
  return Decoder.of((input) => {
      if (input === value) return succeed(value);

      if (typeof value === "number" && typeof input === "string") {
        const parsed = Number(input);
        if (!Number.isNaN(parsed) && parsed === value) return succeed(value);
      }

      if (typeof value === "boolean" && typeof input === "string" && input === String(value)) {
        return succeed(value);
      }

      if (value === null && input === "null") return succeed(value);

      return fail("", `Expected literal ${JSON.stringify(value)}.`);
  });
}

/** Strict literal decoder for JSON contexts — no string coercion. */
function strictLiteralDecoder<A extends string | number | boolean | null>(
  value: A,
): Decoder<A> {
  return Decoder.of((input) => {
      if (input === value) return succeed(value);
      return fail("", `Expected literal ${JSON.stringify(value)}.`);
  });
}

/**
 * Array decoder for text contexts (query params, headers).
 * Coerces a lone string into a 1-element array — standard HTTP behavior.
 */
function arrayDecoder<A>(item: Decoder<A>): Decoder<A[]> {
  return Decoder.of((input) => {
      const values = Array.isArray(input) ? input : typeof input === "string" ? [input] : null;
      if (values == null) return fail("", "Expected an array.");

      return decodeArrayItems(item, values);
  });
}

/**
 * Strict array decoder for JSON contexts.
 * Rejects non-array inputs — no string-to-array coercion.
 */
function strictArrayDecoder<A>(item: Decoder<A>): Decoder<A[]> {
  return Decoder.of((input) => {
      if (!Array.isArray(input)) return fail("", "Expected an array.");

      return decodeArrayItems(item, input);
  });
}

function decodeArrayItems<A>(
  item: Decoder<A>,
  values: readonly unknown[],
): DecoderResult<A[]> {
  return traverseEither(values, (value, index) => {
    const decoded = item.decode(value);
    return isLeft(decoded) ? prefixIssues(decoded, `[${index}]`) : decoded;
  });
}

function tupleDecoder<A extends readonly unknown[]>(
  items: TupleDecoderItems<A>,
): Decoder<A> {
  return Decoder.of((input) => {
      if (!Array.isArray(input)) return fail("", "Expected an array.");
      if (input.length !== items.length) {
        return fail("", `Expected a tuple of length ${items.length}.`);
      }

      return traverseEither(items, (decoder, index) => {
        const decoded = decoder.decode(input[index]);
        return isLeft(decoded) ? prefixIssues(decoded, `[${index}]`) : decoded;
      }) as DecoderResult<A>;
  });
}

function recordDecoder<A>(value: Decoder<A>): Decoder<Record<string, A>> {
  return Decoder.of((input) => {
      const object = expectPlainObject(input);
      if (isLeft(object)) return object;

      const result: Record<string, A> = {};
      let issues: ValidationIssue[] | null = null;
      for (const key in object.right) {
        const decoded = value.decode(object.right[key]);
        if (isLeft(decoded)) {
          for (const issue of decoded.left) {
            (issues ??= []).push({ path: `.${key}${issue.path}`, message: issue.message });
          }
        } else {
          result[key] = decoded.right;
        }
      }
      return issues ? failMany(issues) : succeed(result);
  });
}

function objectDecoder<A extends object>(
  fields: ObjectDecoderFields<A>,
  options?: { allowUnknown?: boolean },
): Decoder<A> {
  const fieldEntries = Object.entries(fields).map(
    ([name, decoder]) => [name, decoder as Decoder<unknown>] as const,
  );
  const allowUnknown = options?.allowUnknown ?? false;

  return Decoder.of((input) => {
      const object = expectPlainObject(input);
      if (isLeft(object)) return object;

      const result: Record<string, unknown> = {};
      let issues: ValidationIssue[] | null = null;

      for (const [fieldName, decoder] of fieldEntries) {
        const decoded = decoder.decode(object.right[fieldName]);
        if (isLeft(decoded)) {
          for (const issue of decoded.left) {
            (issues ??= []).push({
              path: `.${fieldName}${issue.path}`,
              message: issue.message,
            });
          }
        } else if (decoded.right !== undefined) {
          result[fieldName] = decoded.right;
        }
      }

      if (!allowUnknown) {
        for (const key in object.right) {
          if (!(key in fields)) {
            (issues ??= []).push({ path: `.${key}`, message: "Unexpected field." });
          }
        }
      }

      return issues ? failMany(issues) : succeed(result as A);
  });
}

function unionDecoder<
  A,
  Variants extends readonly Decoder<A>[] = readonly Decoder<A>[],
>(
  variants: Variants,
): Decoder<A> {
  return Decoder.of((input) => {
      for (const variant of variants) {
        const decoded = variant.decode(input);
        if (!isLeft(decoded)) return decoded;
      }
      return fail("", "Value did not match any allowed variant.");
  });
}

function nullableDecoder<A>(inner: Decoder<A>): Decoder<A | null> {
  return Decoder.of((input) => {
      if (input === null || input === "null") return RIGHT_NULL as DecoderResult<A | null>;
      return inner.decode(input);
  });
}

/** Strict nullable for JSON — only accepts actual `null`, not the string `"null"`. */
function strictNullableDecoder<A>(inner: Decoder<A>): Decoder<A | null> {
  return Decoder.of((input) => {
      if (input === null) return RIGHT_NULL as DecoderResult<A | null>;
      return inner.decode(input);
  });
}

function lazyDecoder<A>(resolve: () => Decoder<A>): Decoder<A> {
  let resolved: Decoder<A> | undefined;
  return Decoder.of((input) => {
      resolved ??= resolve();
      return resolved.decode(input);
  });
}

/** O(1) dispatch for discriminated unions — checks one field, looks up the variant. */
function discriminatedDecoder<A>(
  discriminator: string,
  variants: Readonly<Record<string, Decoder<A>>>,
): Decoder<A> {
  return Decoder.of((input) => {
      const object = expectPlainObject(input);
      if (isLeft(object)) return object;
      const tag = object.right[discriminator];
      const key = typeof tag === "string" || typeof tag === "number" ? String(tag) : undefined;
      const variant = key !== undefined ? variants[key] : undefined;
      if (!variant) {
        return fail(
          `.${discriminator}`,
          `Unknown discriminator value: ${JSON.stringify(tag)}.`,
        );
      }
      return variant.decode(input);
  });
}

// ---------------------------------------------------------------------------
// Decoder transformers
// ---------------------------------------------------------------------------

/** Refine a decoder with a predicate — for @minValue, @maxLength, etc. */
function refineDecoder<A>(
  decoder: Decoder<A>,
  predicate: (value: A) => boolean,
  message: string | ((value: A) => string),
): Decoder<A> {
  return decoder.refine(predicate, message);
}

export const Decoders = {
  string: stringDecoder,
  number: numberDecoder,
  bigint: bigintDecoder,
  boolean: booleanDecoder,
  bytes: bytesDecoder,
  file: fileDecoder,
  unknown: unknownDecoder,
  optional,
  literal: literalDecoder,
  strictLiteral: strictLiteralDecoder,
  array: arrayDecoder,
  strictArray: strictArrayDecoder,
  tuple: tupleDecoder,
  record: recordDecoder,
  object: objectDecoder,
  union: unionDecoder,
  nullable: nullableDecoder,
  strictNullable: strictNullableDecoder,
  lazy: lazyDecoder,
  discriminated: discriminatedDecoder,
  refine: refineDecoder,
} as const;

// ---------------------------------------------------------------------------
// Boundary functions — these create ValidationError at the exit
// ---------------------------------------------------------------------------

/** Converts a decode result (issue array) to Either<ValidationError, A> with path prefix. */
export function toValidationResult<A>(
  result: DecoderResult<A>,
  root: string,
): EitherT<ValidationError, A> {
  if (!isLeft(result)) return result;
  const prefixed = result.left.map((i) => ({ path: root + i.path, message: i.message }));
  return Either.left(new ValidationError(prefixed));
}

/**
 * Decodes one value, prefixes paths, wraps errors in ValidationError.
 */
export function decode<A>(
  decoder: Decoder<A>,
  input: unknown,
  root = "$",
): EitherT<ValidationError, A> {
  return toValidationResult(decoder.decode(input), root);
}

/** Decodes one required value (rejects null/undefined). */
export function decodeRequired<A>(
  decoder: Decoder<A>,
  input: unknown,
): DecoderResult<A> {
  if (input === undefined || input === null) {
    return fail("", "Required value is missing.");
  }
  return decoder.decode(input);
}

/** Decodes one optional value (null/undefined become `undefined`). */
export function decodeOptional<A>(
  decoder: Decoder<A>,
  input: unknown,
): DecoderResult<A | undefined> {
  if (input === undefined || input === null) {
    return RIGHT_UNDEF;
  }
  return decoder.decode(input);
}

/** Parses and validates the request JSON body. Returns Either<ValidationError, A>. */
export async function decodeJsonBody<A>(
  request: Request,
  decoder: Decoder<A>,
  root = "$body",
): Promise<EitherT<ValidationError, A>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return Either.left(new ValidationError([{ path: root, message: "Body must contain valid JSON." }]));
  }
  return toValidationResult(decoder.decode(value), root);
}

/** Parses and validates a URL-encoded form body. Returns Either<ValidationError, A>. */
export async function decodeFormBody<A>(
  request: Request,
  decoder: Decoder<A>,
  root = "$body",
): Promise<EitherT<ValidationError, A>> {
  let value: Record<string, unknown>;
  try {
    const text = await request.text();
    const params = new URLSearchParams(text);
    value = Object.create(null);
    for (const [key, val] of params) {
      appendBodyField(value, key, val);
    }
  } catch {
    return Either.left(new ValidationError([{ path: root, message: "Body must contain valid form data." }]));
  }
  return toValidationResult(decoder.decode(value), root);
}

/** Parses and validates a multipart/form-data body. Returns Either<ValidationError, A>. */
export async function decodeMultipartBody<A>(
  request: Request,
  decoder: Decoder<A>,
  root = "$body",
): Promise<EitherT<ValidationError, A>> {
  let value: Record<string, unknown>;
  try {
    const formData = await request.formData();
    value = Object.create(null);
    for (const [key, val] of formData) {
      appendBodyField(value, key, val);
    }
  } catch {
    return Either.left(new ValidationError([{ path: root, message: "Body must contain valid multipart form data." }]));
  }
  return toValidationResult(decoder.decode(value), root);
}

/** Decodes one value and throws `ValidationError` on failure. */
export function decodeOrThrow<A>(
  decoder: Decoder<A>,
  input: unknown,
  root = "$",
): A {
  return Either.getOrElseThrow(decode(decoder, input, root));
}

/** Decodes one required value and throws on failure. */
export function decodeRequiredOrThrow<A>(
  decoder: Decoder<A>,
  input: unknown,
  path: string,
): A {
  return Either.getOrElseThrow(toValidationResult(decodeRequired(decoder, input), path));
}

/** Decodes one optional value and throws on failure. */
export function decodeOptionalOrThrow<A>(
  decoder: Decoder<A>,
  input: unknown,
  path: string,
): A | undefined {
  return Either.getOrElseThrow(toValidationResult(decodeOptional(decoder, input), path));
}

/** Parses and validates the request JSON body, throws on failure. */
export async function decodeJsonBodyOrThrow<A>(
  request: Request,
  decoder: Decoder<A>,
  root = "$body",
): Promise<A> {
  return Either.getOrElseThrow(await decodeJsonBody(request, decoder, root));
}

// ---------------------------------------------------------------------------
// Private byte helpers
// ---------------------------------------------------------------------------

function decodeByteArray(
  input: unknown[],
): DecoderResult<Uint8Array> {
  const bytes = new Uint8Array(input.length);
  let issues: ValidationIssue[] | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (typeof item !== "number" || !Number.isInteger(item) || item < 0 || item > 255) {
      (issues ??= []).push({
        path: `[${index}]`,
        message: "Expected a byte value between 0 and 255.",
      });
      continue;
    }
    bytes[index] = item;
  }

  return issues ? failMany(issues) : succeed(bytes);
}

function decodeBase64(
  input: string,
): DecoderResult<Uint8Array> {
  try {
    const normalized = normalizeBase64(input);
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return succeed(bytes);
  } catch {
    return fail("", "Expected a valid base64 string.");
  }
}

function normalizeBase64(value: string): string {
  const padding = value.length % 4;
  if (padding === 0) return value;
  return `${value}${"=".repeat(4 - padding)}`;
}

function appendBodyField(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (!Object.prototype.hasOwnProperty.call(target, key)) {
    target[key] = value;
    return;
  }

  const existing = target[key];
  if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    target[key] = [existing, value];
  }
}
