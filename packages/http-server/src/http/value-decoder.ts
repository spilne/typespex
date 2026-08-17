// Value validation and composable decoder primitives.
import { ScalarEncodings, type DurationNumericUnit } from "@typespex/codec";
import { Either, isLeft, type Either as EitherT } from "../core/either.js";
import { isContentTypeAccepted } from "./media-type.js";
import { defineDataProperty } from "./object-properties.js";
import { type ValidationIssue, type Validator, ValidationError, Validators } from "./validation.js";

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

export interface ObjectDecoderOptions<AdditionalProperty = unknown> {
  /**
   * Maps handler-facing property names to their encoded wire names.
   *
   * Decoding reads and reports paths using the wire name, then stores the
   * decoded value under the handler-facing field name.
   */
  readonly wireNames?: Readonly<Record<string, string>>;
  /**
   * Accept undeclared fields without preserving them in the decoded result.
   *
   * Ignored when `additionalProperties` is provided, because those fields are
   * decoded and preserved instead.
   */
  readonly allowUnknown?: boolean;
  /** Decoder applied to every undeclared own field. Successful values are preserved. */
  readonly additionalProperties?: Decoder<AdditionalProperty>;
  /**
   * Undeclared field names that must still be rejected.
   *
   * This is used for named properties excluded from a payload projection, so
   * enabling unknown or additional properties cannot reintroduce them.
   */
  readonly forbiddenProperties?: readonly string[];
}

export interface DiscriminatedDecoderOptions<A> {
  /** Decoder used when a string/number discriminator has no named variant. */
  readonly defaultVariant?: Decoder<A>;
}

type ObjectAdditionalProperty<A extends object> = string extends keyof A
  ? A[string & keyof A]
  : unknown;

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
export function failMany(issues: readonly ValidationIssue[]): DecoderResult<never> {
  return Either.left(issues);
}

function expectPlainObject(input: unknown): DecoderResult<Record<string, unknown>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail("", "Expected an object.");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail("", "Expected a plain object.");
  }
  return succeed(input as Record<string, unknown>);
}

/** Prefix every issue path in a Left with `prefix`. Identity on Right. */
export function prefixIssues<A>(either: DecoderResult<A>, prefix: string): DecoderResult<A> {
  if (!isLeft(either)) return either;
  return Either.left(either.left.map((i) => ({ path: prefix + i.path, message: i.message })));
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

const DECIMAL_NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const DECIMAL_INTEGER_PATTERN = /^-?(?:0|[1-9]\d*)$/;
// uint64 is the widest exact integer type emitted by TypeSpec. Bounding the
// token before conversion prevents untrusted JSON from reaching BigInt with
// an arbitrarily large allocation.

const strictNumberDecoder: Decoder<number> = Decoder.of((input) => {
  if (typeof input === "number" && Number.isFinite(input)) return succeed(input);
  return fail("", "Expected a finite number.");
});

const numberDecoder: Decoder<number> = Decoder.of((input) => {
  if (typeof input === "number" && Number.isFinite(input)) return succeed(input);
  if (typeof input === "string" && DECIMAL_NUMBER_PATTERN.test(input)) {
    const parsed = Number(input);
    if (Number.isFinite(parsed)) return succeed(parsed);
  }
  return fail("", "Expected a finite number.");
});

const bigintDecoder: Decoder<bigint> = Decoder.of((input) => {
  if (typeof input === "bigint") return succeed(input);
  if (typeof input === "number" && Number.isSafeInteger(input)) return succeed(BigInt(input));
  if (typeof input === "string" && DECIMAL_INTEGER_PATTERN.test(input)) {
    return succeed(BigInt(input));
  }
  return fail("", "Expected a valid integer.");
});

const strictBigintDecoder: Decoder<bigint> = Decoder.of((input) => {
  if (typeof input === "bigint") return succeed(input);
  if (typeof input === "number" && Number.isSafeInteger(input)) return succeed(BigInt(input));
  return fail("", "Expected a valid integer.");
});

const booleanDecoder: Decoder<boolean> = Decoder.of((input) => {
  if (input === true) return RIGHT_TRUE;
  if (input === false) return RIGHT_FALSE;
  if (input === "true") return RIGHT_TRUE;
  if (input === "false") return RIGHT_FALSE;
  return fail("", 'Expected "true" or "false".');
});

const strictBooleanDecoder: Decoder<boolean> = Decoder.of((input) => {
  if (input === true) return RIGHT_TRUE;
  if (input === false) return RIGHT_FALSE;
  return fail("", "Expected a boolean.");
});

// `integer` maps to TypeScript `number`; accepting values outside the safe
// range would silently corrupt them before validation can run.
const integerDecoder = numberDecoder.refine(Number.isSafeInteger, "Expected an integer.");
const strictIntegerDecoder = strictNumberDecoder.refine(
  Number.isSafeInteger,
  "Expected an integer.",
);
const safeIntegerDecoder = numberDecoder.refine(Number.isSafeInteger, "Expected a safe integer.");
const strictSafeIntegerDecoder = strictNumberDecoder.refine(
  Number.isSafeInteger,
  "Expected a safe integer.",
);

const bytesDecoder: Decoder<Uint8Array> = Decoder.of((input) => {
  if (input instanceof Uint8Array) return succeed(input);
  if (typeof input === "string") return decodeBase64(input);
  if (Array.isArray(input)) return decodeByteArray(input);
  return fail("", "Expected a base64 string or byte array.");
});

const strictBytesDecoder: Decoder<Uint8Array> = Decoder.of((input) => {
  if (typeof input === "string") return decodeBase64(input);
  return fail("", "Expected a base64 string.");
});

function transformDecoder<A, B, Input>(
  decoder: Decoder<A, Input>,
  transform: (value: A) => B,
): Decoder<B, Input> {
  return Decoder.of((input) => {
    const decoded = decoder.decode(input);
    if (isLeft(decoded)) return decoded;
    try {
      return succeed(transform(decoded.right));
    } catch (error) {
      return fail("", error instanceof Error ? error.message : String(error));
    }
  });
}

function composeDecoder<A, B, Input>(
  first: Decoder<A, Input>,
  next: Decoder<B, A>,
): Decoder<B, Input> {
  return Decoder.of((input) => Either.flatMap(first.decode(input), (value) => next.decode(value)));
}

const encodedNumberStringDecoder = transformDecoder(
  stringDecoder,
  ScalarEncodings.decodeNumberString,
);
const encodedIntegerStringDecoder = transformDecoder(
  stringDecoder,
  ScalarEncodings.decodeIntegerString,
);
const encodedBigIntStringDecoder = transformDecoder(
  stringDecoder,
  ScalarEncodings.decodeBigIntString,
);
const encodedBooleanStringDecoder = transformDecoder(
  stringDecoder,
  ScalarEncodings.decodeBooleanString,
);
const rfc3339DateTimeDecoder = transformDecoder(
  stringDecoder,
  ScalarEncodings.decodeRfc3339DateTime,
);
const rfc7231DateTimeDecoder = transformDecoder(
  stringDecoder,
  ScalarEncodings.decodeRfc7231DateTime,
);
const isoDurationDecoder = transformDecoder(stringDecoder, ScalarEncodings.decodeIsoDuration);
const base64UrlBytesDecoder = transformDecoder(stringDecoder, ScalarEncodings.decodeBase64Url);

function unixTimestampDecoder<A extends number | bigint>(wire: Decoder<A>): Decoder<string> {
  return transformDecoder(wire, ScalarEncodings.decodeUnixTimestamp);
}

function dateTimeDateDecoder<Input>(wire: Decoder<string, Input>): Decoder<Date, Input> {
  return transformDecoder(wire, ScalarEncodings.decodeDateTimeDate);
}

function numericDurationDecoder<A extends number | bigint>(
  wire: Decoder<A>,
  unit: DurationNumericUnit,
): Decoder<string> {
  return transformDecoder(wire, (value) => ScalarEncodings.decodeNumericDuration(value, unit));
}

const fileDecoder: Decoder<File> = Decoder.of((input) => {
  if (input instanceof File) return succeed(input);
  return fail("", "Expected a file.");
});

export interface FileDecoderOptions {
  readonly requireContentType?: boolean;
}

function fileWithContentTypesDecoder(
  contentTypes: readonly string[],
  options: FileDecoderOptions = {},
): Decoder<File> {
  return Decoder.of((input) => {
    if (!(input instanceof File)) return fail("", "Expected a file.");
    if (!input.type && options.requireContentType) {
      return fail("", "Expected a file content type.");
    }
    if (input.type && contentTypes.length > 0 && !isContentTypeAccepted(input.type, contentTypes)) {
      return fail("", `File content type "${input.type}" is outside its declared contract.`);
    }
    return succeed(input);
  });
}

const unknownDecoder: Decoder<unknown> = Decoder.of((input) => {
  return succeed(input);
});

const neverDecoder: Decoder<never> = Decoder.of(() => {
  return fail("", "Expected no value.");
});

// ---------------------------------------------------------------------------
// Combinator decoders
// ---------------------------------------------------------------------------

type LiteralValue = string | number | bigint | boolean | null;

function literalDecoder<A extends LiteralValue>(value: A): Decoder<A> {
  return Decoder.of((input) => {
    if (input === value) return succeed(value);

    if (typeof value === "number" && typeof input === "string") {
      if (DECIMAL_NUMBER_PATTERN.test(input) && Number(input) === value) return succeed(value);
    }

    if (typeof value === "bigint" && typeof input === "string") {
      const canonical = String(value);
      if (input === canonical || (value === 0n && input === "-0")) return succeed(value);
    }

    if (typeof value === "boolean" && typeof input === "string" && input === String(value)) {
      return succeed(value);
    }

    if (value === null && input === "null") return succeed(value);

    return fail("", `Expected literal ${formatLiteral(value)}.`);
  });
}

/** Strict literal decoder for JSON contexts — no string coercion. */
function strictLiteralDecoder<A extends LiteralValue>(value: A): Decoder<A> {
  return Decoder.of((input) => {
    if (input === value) return succeed(value);
    return fail("", `Expected literal ${formatLiteral(value)}.`);
  });
}

function formatLiteral(value: LiteralValue): string {
  return typeof value === "bigint" ? `${value}n` : JSON.stringify(value);
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

/** Array decoder for form fields that may occur once or multiple times. */
function oneOrManyDecoder<A>(item: Decoder<A>): Decoder<A[]> {
  return Decoder.of((input) => {
    if (input === undefined || input === null) return fail("", "Expected an array.");
    return decodeArrayItems(item, Array.isArray(input) ? input : [input]);
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

function decodeArrayItems<A>(item: Decoder<A>, values: readonly unknown[]): DecoderResult<A[]> {
  return traverseEither(values, (value, index) => {
    const decoded = item.decode(value);
    return isLeft(decoded) ? prefixIssues(decoded, `[${index}]`) : decoded;
  });
}

function tupleDecoder<A extends readonly unknown[]>(items: TupleDecoderItems<A>): Decoder<A> {
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
    for (const key of Object.keys(object.right)) {
      const decoded = value.decode(object.right[key]);
      if (isLeft(decoded)) {
        for (const issue of decoded.left) {
          (issues ??= []).push({ path: `.${key}${issue.path}`, message: issue.message });
        }
      } else {
        defineDataProperty(result, key, decoded.right);
      }
    }
    return issues ? failMany(issues) : succeed(result);
  });
}

function objectDecoder<A extends object>(
  fields: ObjectDecoderFields<A>,
  options?: ObjectDecoderOptions<ObjectAdditionalProperty<A>>,
): Decoder<A> {
  const wireNames = options?.wireNames ?? {};
  const fieldEntries = Object.entries(fields).map(
    ([name, decoder]) =>
      [
        name,
        Object.prototype.hasOwnProperty.call(wireNames, name) ? wireNames[name]! : name,
        decoder as Decoder<unknown>,
      ] as const,
  );
  const declaredProperties = new Set(fieldEntries.map(([, wireName]) => wireName));
  if (declaredProperties.size !== fieldEntries.length) {
    throw new TypeError("Object decoder fields must have unique wire names.");
  }
  for (const name of Object.keys(wireNames)) {
    if (!Object.prototype.hasOwnProperty.call(fields, name)) {
      throw new TypeError(
        `Object decoder wire name references unknown field ${JSON.stringify(name)}.`,
      );
    }
  }
  const allowUnknown = options?.allowUnknown ?? false;
  const additionalProperties = options?.additionalProperties;
  const forbiddenProperties = new Set(options?.forbiddenProperties);

  return Decoder.of((input) => {
    const object = expectPlainObject(input);
    if (isLeft(object)) return object;

    const result: Record<string, unknown> = {};
    let issues: ValidationIssue[] | null = null;

    for (const [fieldName, wireName, decoder] of fieldEntries) {
      const inputValue = Object.prototype.hasOwnProperty.call(object.right, wireName)
        ? object.right[wireName]
        : undefined;
      const decoded = decoder.decode(inputValue);
      if (isLeft(decoded)) {
        for (const issue of decoded.left) {
          (issues ??= []).push({
            path: `.${wireName}${issue.path}`,
            message: issue.message,
          });
        }
      } else if (decoded.right !== undefined) {
        defineDataProperty(result, fieldName, decoded.right);
      }
    }

    for (const key of Object.keys(object.right)) {
      if (declaredProperties.has(key)) continue;

      if (forbiddenProperties.has(key)) {
        (issues ??= []).push({ path: `.${key}`, message: "Unexpected field." });
        continue;
      }

      if (additionalProperties) {
        const decoded = additionalProperties.decode(object.right[key]);
        if (isLeft(decoded)) {
          for (const issue of decoded.left) {
            (issues ??= []).push({
              path: `.${key}${issue.path}`,
              message: issue.message,
            });
          }
        } else {
          defineDataProperty(result, key, decoded.right);
        }
      } else if (!allowUnknown) {
        (issues ??= []).push({ path: `.${key}`, message: "Unexpected field." });
      }
    }

    return issues ? failMany(issues) : succeed(result as A);
  });
}

type DecoderOutput<TDecoder> = TDecoder extends Decoder<infer A, infer _Input> ? A : never;

// Keep inference first so unannotated calls derive every member output, then
// retain the explicit `union<T>(...)` overload for the existing public API.
function unionDecoder<const Variants extends readonly Decoder<unknown>[]>(
  variants: Variants,
): Decoder<DecoderOutput<Variants[number]>>;
function unionDecoder<A>(variants: readonly Decoder<A>[]): Decoder<A>;
function unionDecoder(variants: readonly Decoder<unknown>[]): Decoder<unknown> {
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
  options: DiscriminatedDecoderOptions<A> = {},
): Decoder<A> {
  return Decoder.of((input) => {
    const object = expectPlainObject(input);
    if (isLeft(object)) return object;
    const tag = Object.prototype.hasOwnProperty.call(object.right, discriminator)
      ? object.right[discriminator]
      : undefined;
    const key =
      typeof tag === "string" || typeof tag === "number" || typeof tag === "bigint"
        ? String(tag)
        : undefined;
    const namedVariant =
      key !== undefined && Object.prototype.hasOwnProperty.call(variants, key)
        ? variants[key]
        : undefined;
    const variant = namedVariant ?? (key === undefined ? undefined : options.defaultVariant);
    if (!variant) {
      return fail(`.${discriminator}`, `Unknown discriminator value: ${formatUnknownValue(tag)}.`);
    }
    return variant.decode(input);
  });
}

function formatUnknownValue(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  return JSON.stringify(value) ?? String(value);
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

// ---------------------------------------------------------------------------

export const valueDecoders = {
  string: stringDecoder,
  number: numberDecoder,
  strictNumber: strictNumberDecoder,
  integer: integerDecoder,
  strictInteger: strictIntegerDecoder,
  safeInteger: safeIntegerDecoder,
  strictSafeInteger: strictSafeIntegerDecoder,
  bigint: bigintDecoder,
  strictBigint: strictBigintDecoder,
  boolean: booleanDecoder,
  strictBoolean: strictBooleanDecoder,
  bytes: bytesDecoder,
  strictBytes: strictBytesDecoder,
  compose: composeDecoder,
  transform: transformDecoder,
  encodedNumberString: encodedNumberStringDecoder,
  encodedIntegerString: encodedIntegerStringDecoder,
  encodedBigIntString: encodedBigIntStringDecoder,
  encodedBooleanString: encodedBooleanStringDecoder,
  rfc3339DateTime: rfc3339DateTimeDecoder,
  rfc7231DateTime: rfc7231DateTimeDecoder,
  dateTimeDate: dateTimeDateDecoder,
  unixTimestamp: unixTimestampDecoder,
  isoDuration: isoDurationDecoder,
  numericDuration: numericDurationDecoder,
  base64UrlBytes: base64UrlBytesDecoder,
  file: fileDecoder,
  fileWithContentTypes: fileWithContentTypesDecoder,
  unknown: unknownDecoder,
  never: neverDecoder,
  optional,
  literal: literalDecoder,
  strictLiteral: strictLiteralDecoder,
  array: arrayDecoder,
  oneOrMany: oneOrManyDecoder,
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
export function decodeRequired<A>(decoder: Decoder<A>, input: unknown): DecoderResult<A> {
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

/** Decodes one value and throws `ValidationError` on failure. */
export function decodeOrThrow<A>(decoder: Decoder<A>, input: unknown, root = "$"): A {
  return Either.getOrElseThrow(decode(decoder, input, root));
}

/** Decodes one required value and throws on failure. */
export function decodeRequiredOrThrow<A>(decoder: Decoder<A>, input: unknown, path: string): A {
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

// ---------------------------------------------------------------------------
// Private byte helpers
// ---------------------------------------------------------------------------

function decodeByteArray(input: unknown[]): DecoderResult<Uint8Array> {
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

function decodeBase64(input: string): DecoderResult<Uint8Array> {
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
