import { Either, isLeft, type Either as EitherT } from "../core/either.js";
import { parse as parseLosslessJson } from "lossless-json";
import {
  enforceRequestBodyLimit,
  inheritRequestBodyLimit,
  releaseRequestBodyLimit,
  type RequestBodyLimit,
  RequestBodyTooLargeError,
} from "./body-limit.js";
import { isContentTypeAccepted, parseMediaType } from "./media-type.js";
import {
  type ParsedMultipartBody,
  type ParsedMultipartPart,
  MultipartSyntaxError,
  parseMultipartRequest,
  validateFileName,
} from "./multipart.js";
import { ScalarEncodings, type DurationNumericUnit } from "./scalar-encoding.js";
import {
  type ValidationIssue,
  type Validator,
  UnsupportedMediaTypeError,
  ValidationError,
  Validators,
} from "./validation.js";

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
function failMany(issues: readonly ValidationIssue[]): DecoderResult<never> {
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
const MAX_LOSSLESS_JSON_INTEGER_DIGITS = 20;

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

function transformDecoder<A, B>(decoder: Decoder<A>, transform: (value: A) => B): Decoder<B> {
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

function literalDecoder<A extends string | number | boolean | null>(value: A): Decoder<A> {
  return Decoder.of((input) => {
    if (input === value) return succeed(value);

    if (typeof value === "number" && typeof input === "string") {
      if (DECIMAL_NUMBER_PATTERN.test(input) && Number(input) === value) return succeed(value);
    }

    if (typeof value === "boolean" && typeof input === "string" && input === String(value)) {
      return succeed(value);
    }

    if (value === null && input === "null") return succeed(value);

    return fail("", `Expected literal ${JSON.stringify(value)}.`);
  });
}

/** Strict literal decoder for JSON contexts — no string coercion. */
function strictLiteralDecoder<A extends string | number | boolean | null>(value: A): Decoder<A> {
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

function defineDataProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function unionDecoder<A, Variants extends readonly Decoder<A>[] = readonly Decoder<A>[]>(
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
    const variant =
      key !== undefined && Object.prototype.hasOwnProperty.call(variants, key)
        ? variants[key]
        : undefined;
    if (!variant) {
      return fail(`.${discriminator}`, `Unknown discriminator value: ${JSON.stringify(tag)}.`);
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

// ---------------------------------------------------------------------------
// Schema-aware multipart decoders
// ---------------------------------------------------------------------------

export type MultipartPartKind = "text" | "binary" | "json" | "file";

export type MultipartPartDecoderMap<A = unknown> = Readonly<
  Partial<Record<MultipartPartKind, Decoder<A>>>
>;

interface MultipartPartDescriptorOptions {
  /** Allowed media types for this part. Parameters are ignored during matching. */
  readonly contentTypes?: readonly string[];
  /** Reject a part that omits Content-Type. */
  readonly requireContentType?: boolean;
  /** The part may be omitted. */
  readonly optional?: boolean;
  /** The part may occur more than once and is returned as an array. */
  readonly multi?: boolean;
  /** Wire Content-Disposition name. Required for named bodies and form-data tuples. */
  readonly name?: string;
  /** Handler property name. Required for named bodies and omitted for tuples. */
  readonly property?: string;
  /**
   * For File parts, relocate File.name to this per-part header. When set,
   * Content-Disposition's filename parameter is intentionally ignored.
   */
  readonly fileNameHeader?: string;
  /** Reject a File part when its selected filename metadata is absent. */
  readonly requireFileName?: boolean;
}

/** Schema for one logical multipart field or tuple element. */
export type MultipartPartDescriptor<A = unknown> = MultipartPartDescriptorOptions &
  (
    | {
        /** Parser used for one homogeneous wire representation. */
        readonly kind: MultipartPartKind;
        readonly decoder: Decoder<A>;
        readonly decoders?: never;
      }
    | {
        /** Parsers selected from the received per-part Content-Type. */
        readonly decoders: MultipartPartDecoderMap<A>;
        readonly kind?: never;
        readonly decoder?: never;
      }
  );

type MultipartOptionalDescriptorFlag<Value> = undefined extends Value
  ? { readonly optional: true }
  : { readonly optional?: false };

type MultipartDescriptorForValue<Value> = (Exclude<Value, undefined> extends readonly (infer Item)[]
  ? MultipartPartDescriptor<Item> & { readonly multi: true }
  : MultipartPartDescriptor<Exclude<Value, undefined>> & { readonly multi?: false }) &
  MultipartOptionalDescriptorFlag<Value>;

/** Descriptor union keyed by the handler properties of one named multipart body. */
export type MultipartFormDataDescriptor<A extends object> = {
  [Key in Extract<keyof A, string>]-?: MultipartDescriptorForValue<A[Key]> & {
    readonly name: string;
    readonly property: Key;
  };
}[Extract<keyof A, string>];

/** Positional descriptors corresponding to one multipart tuple handler value. */
export type MultipartTupleDescriptors<A extends readonly unknown[]> = {
  readonly [Key in keyof A]: MultipartDescriptorForValue<A[Key]> & {
    readonly property?: never;
  };
};

type MultipartSchemaMode = "form-data" | "tuple";

const MULTIPART_BODY = Symbol("typespex.multipart.body");

type MultipartDecoderInput = Record<string, unknown> & {
  readonly [MULTIPART_BODY]: ParsedMultipartBody;
};

class MultipartSchemaDecoder<A> extends Decoder<A> {
  constructor(
    private readonly mode: MultipartSchemaMode,
    private readonly parts: readonly MultipartPartDescriptor[],
  ) {
    super();
  }

  decode(input: unknown): DecoderResult<A> {
    const body = getParsedMultipartBody(input);
    if (!body) return fail("", "Expected a parsed multipart body.");
    const schemaIssues = validateMultipartSchema(this.mode, this.parts);
    if (schemaIssues.length > 0) return failMany(schemaIssues);
    return (
      this.mode === "form-data"
        ? decodeMultipartFormData(this.parts, body)
        : decodeMultipartTuple(this.parts, body)
    ) as DecoderResult<A>;
  }
}

/**
 * Builds a schema-aware decoder for named multipart fields.
 *
 * Generated descriptors provide both `name` (wire name) and `property`
 * (handler property), which need not be equal. This supports form-data and
 * named model bodies carried by other multipart subtypes.
 */
function multipartFormDataDecoder<A extends object>(
  parts: readonly MultipartFormDataDescriptor<A>[],
): Decoder<A> {
  return new MultipartSchemaDecoder("form-data", parts as readonly MultipartPartDescriptor[]);
}

/** Builds a schema-aware decoder for ordered multipart tuple parts. */
function multipartTupleDecoder<A extends readonly unknown[]>(
  parts: MultipartTupleDescriptors<A>,
): Decoder<A> {
  return new MultipartSchemaDecoder("tuple", parts as readonly MultipartPartDescriptor[]);
}

function getParsedMultipartBody(input: unknown): ParsedMultipartBody | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  return (input as Partial<MultipartDecoderInput>)[MULTIPART_BODY];
}

function validateMultipartSchema(
  mode: MultipartSchemaMode,
  descriptors: readonly MultipartPartDescriptor[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const names = new Set<string>();
  const properties = new Set<string>();
  if (descriptors.length > 256) {
    issues.push({ path: "", message: "Multipart schema exceeds the 256-part limit." });
    return issues;
  }

  for (let index = 0; index < descriptors.length; index++) {
    const descriptor = descriptors[index]!;
    const path = mode === "tuple" ? `[${index}]` : "";
    const decoders = descriptorDecoders(descriptor);
    if (Object.keys(decoders).length === 0) {
      issues.push({ path, message: "Multipart part has no decoder." });
    }
    if (descriptor.fileNameHeader !== undefined) {
      if (!isHeaderName(descriptor.fileNameHeader)) {
        issues.push({ path, message: "Multipart filename header name is invalid." });
      }
      if (!decoders.file) {
        issues.push({
          path,
          message: "Multipart filename metadata may only be used with a File decoder.",
        });
      }
    }
    if (descriptor.requireFileName && !decoders.file) {
      issues.push({
        path,
        message: "Required filename metadata may only be used with a File decoder.",
      });
    }

    if (mode === "form-data") {
      if (!descriptor.name || !descriptor.property) {
        issues.push({
          path,
          message: "Named multipart parts require wire and handler property names.",
        });
        continue;
      }
      if (names.has(descriptor.name)) {
        issues.push({ path: `.${descriptor.property}`, message: "Duplicate multipart wire name." });
      }
      if (properties.has(descriptor.property)) {
        issues.push({
          path: `.${descriptor.property}`,
          message: "Duplicate multipart handler property.",
        });
      }
      names.add(descriptor.name);
      properties.add(descriptor.property);
    } else if (descriptor.property !== undefined) {
      issues.push({
        path,
        message: "Ordered multipart tuple parts must not declare handler properties.",
      });
    }
  }
  return issues;
}

function decodeMultipartFormData(
  descriptors: readonly MultipartPartDescriptor[],
  body: ParsedMultipartBody,
): DecoderResult<Record<string, unknown>> {
  const byName = new Map<string, ParsedMultipartPart[]>();
  const issues: ValidationIssue[] = [];
  for (let index = 0; index < body.parts.length; index++) {
    const part = body.parts[index]!;
    const disposition = part.disposition;
    if (
      !disposition?.name ||
      (body.mediaType === "multipart/form-data" && disposition.type !== "form-data")
    ) {
      issues.push({
        path: `[${index}]`,
        message:
          body.mediaType === "multipart/form-data"
            ? "Named form-data parts require Content-Disposition: form-data with a name."
            : "Named multipart parts require Content-Disposition with a name.",
      });
      continue;
    }
    const values = byName.get(disposition.name);
    if (values) values.push(part);
    else byName.set(disposition.name, [part]);
  }

  const knownNames = new Set(descriptors.map((part) => part.name!));
  for (const name of byName.keys()) {
    if (!knownNames.has(name)) {
      issues.push({ path: `.${name}`, message: "Unexpected multipart part." });
    }
  }

  const output: Record<string, unknown> = {};
  for (const descriptor of descriptors) {
    const property = descriptor.property!;
    const values = byName.get(descriptor.name!) ?? [];
    const cardinality = validateNamedPartCardinality(descriptor, values.length, property);
    if (cardinality) {
      issues.push(cardinality);
      continue;
    }
    if (values.length === 0) continue;

    if (descriptor.multi) {
      const decoded = traverseEither(values, (part, index) =>
        prefixIssues(decodeMultipartPart(descriptor, part), `.${property}[${index}]`),
      );
      if (isLeft(decoded)) issues.push(...decoded.left);
      else defineDataProperty(output, property, decoded.right);
    } else {
      const decoded = prefixIssues(decodeMultipartPart(descriptor, values[0]!), `.${property}`);
      if (isLeft(decoded)) issues.push(...decoded.left);
      else defineDataProperty(output, property, decoded.right);
    }
  }

  return issues.length > 0 ? failMany(issues) : succeed(output);
}

function validateNamedPartCardinality(
  descriptor: MultipartPartDescriptor,
  count: number,
  property: string,
): ValidationIssue | undefined {
  if (count === 0 && !descriptor.optional) {
    return { path: `.${property}`, message: "Required multipart part is missing." };
  }
  if (!descriptor.multi && count > 1) {
    return { path: `.${property}`, message: "Multipart part must occur at most once." };
  }
  return undefined;
}

function decodeMultipartTuple(
  descriptors: readonly MultipartPartDescriptor[],
  body: ParsedMultipartBody,
): DecoderResult<unknown[]> {
  const assignment = resolveTupleCardinality(descriptors, body);
  if (isLeft(assignment)) return assignment;

  const output: unknown[] = [];
  const issues: ValidationIssue[] = [];
  let partIndex = 0;
  for (let descriptorIndex = 0; descriptorIndex < descriptors.length; descriptorIndex++) {
    const descriptor = descriptors[descriptorIndex]!;
    const count = assignment.right[descriptorIndex]!;
    if (count === 0 && descriptor.optional) {
      output.push(undefined);
    } else if (descriptor.multi) {
      const values = body.parts.slice(partIndex, partIndex + count);
      const decoded = traverseEither(values, (part, repeatedIndex) =>
        prefixIssues(
          decodeMultipartTuplePart(descriptor, part, body.mediaType),
          `[${descriptorIndex}][${repeatedIndex}]`,
        ),
      );
      if (isLeft(decoded)) issues.push(...decoded.left);
      else output.push(decoded.right);
    } else {
      const decoded = prefixIssues(
        decodeMultipartTuplePart(descriptor, body.parts[partIndex]!, body.mediaType),
        `[${descriptorIndex}]`,
      );
      if (isLeft(decoded)) issues.push(...decoded.left);
      else output.push(decoded.right);
    }
    partIndex += count;
  }

  return issues.length > 0 ? failMany(issues) : succeed(output);
}

function decodeMultipartTuplePart(
  descriptor: MultipartPartDescriptor,
  part: ParsedMultipartPart,
  outerMediaType: string,
): DecoderResult<unknown> {
  const expectedName = descriptor.name;
  const actualDisposition = part.disposition;
  if (outerMediaType === "multipart/form-data") {
    if (!expectedName) {
      return fail("", "Tuple form-data parts require a declared wire name.");
    }
    if (actualDisposition?.type !== "form-data" || actualDisposition.name !== expectedName) {
      return fail("", `Expected multipart form-data part named "${expectedName}".`);
    }
  } else if (expectedName !== undefined && actualDisposition?.name !== expectedName) {
    return fail("", `Expected multipart part named "${expectedName}".`);
  }
  return decodeMultipartPart(descriptor, part);
}

function resolveTupleCardinality(
  descriptors: readonly MultipartPartDescriptor[],
  body: ParsedMultipartBody,
): DecoderResult<number[]> {
  const received = body.parts.length;
  const minimum = descriptors.reduce(
    (total, descriptor) => total + (descriptor.optional ? 0 : 1),
    0,
  );
  const hasMulti = descriptors.some((descriptor) => descriptor.multi);
  const maximum = hasMulti ? Number.POSITIVE_INFINITY : descriptors.length;
  if (received < minimum) {
    return fail("", `Expected at least ${minimum} multipart part(s), received ${received}.`);
  }
  if (received > maximum) {
    return fail("", `Expected at most ${maximum} multipart part(s), received ${received}.`);
  }

  interface Match {
    readonly ways: 0 | 1 | 2;
    readonly counts?: readonly number[];
  }
  const solve = (useWireEvidence: boolean): Match => {
    const memo = new Map<string, Match>();
    const match = (descriptorIndex: number, partIndex: number): Match => {
      const memoKey = `${descriptorIndex}:${partIndex}`;
      const cached = memo.get(memoKey);
      if (cached) return cached;
      if (descriptorIndex === descriptors.length) {
        const terminal: Match =
          partIndex === body.parts.length ? { ways: 1, counts: [] } : { ways: 0 };
        memo.set(memoKey, terminal);
        return terminal;
      }

      const descriptor = descriptors[descriptorIndex]!;
      const min = descriptor.optional ? 0 : 1;
      const available = body.parts.length - partIndex;
      const max = descriptor.multi ? available : Math.min(1, available);
      let ways: 0 | 1 | 2 = 0;
      let firstCounts: readonly number[] | undefined;
      for (let count = min; count <= max; count++) {
        if (
          useWireEvidence &&
          count > 0 &&
          !tuplePartMatchesDescriptor(
            descriptor,
            body.parts[partIndex + count - 1]!,
            body.mediaType,
          )
        ) {
          break;
        }
        const suffix = match(descriptorIndex + 1, partIndex + count);
        if (suffix.ways === 0) continue;
        if (!firstCounts && suffix.counts) firstCounts = [count, ...suffix.counts];
        ways = Math.min(2, ways + suffix.ways) as 1 | 2;
        if (ways === 2) break;
      }
      const result: Match = firstCounts ? { ways, counts: firstCounts } : { ways: 0 };
      memo.set(memoKey, result);
      return result;
    };
    return match(0, 0);
  };
  let solution = solve(true);

  if (solution.ways === 0 || !solution.counts) {
    // When cardinality itself has exactly one interpretation, preserve that
    // assignment so the regular part decoder can report the precise invalid
    // name, media type, or filename issue.
    const cardinalityOnly = solve(false);
    if (cardinalityOnly.ways === 1 && cardinalityOnly.counts) {
      solution = cardinalityOnly;
    } else {
      return fail("", "Multipart tuple parts do not match their declared wire contracts.");
    }
  }
  if (solution.ways > 1) {
    return fail(
      "",
      "Multipart tuple cardinality is ambiguous after matching part names and media types.",
    );
  }
  const resolvedCounts = solution.counts;
  return resolvedCounts
    ? succeed([...resolvedCounts])
    : fail("", "Multipart tuple cardinality could not be resolved.");
}

function tuplePartMatchesDescriptor(
  descriptor: MultipartPartDescriptor,
  part: ParsedMultipartPart,
  outerMediaType: string,
): boolean {
  if (outerMediaType === "multipart/form-data") {
    if (
      !descriptor.name ||
      part.disposition?.type !== "form-data" ||
      part.disposition.name !== descriptor.name
    ) {
      return false;
    }
  } else if (descriptor.name !== undefined && part.disposition?.name !== descriptor.name) {
    return false;
  }
  if (descriptor.requireContentType && !part.contentType) return false;
  if (
    part.contentType &&
    descriptor.contentTypes &&
    descriptor.contentTypes.length > 0 &&
    !isContentTypeAccepted(part.contentType, descriptor.contentTypes)
  ) {
    return false;
  }
  const kind = selectMultipartPartKind(descriptorDecoders(descriptor), part.contentType);
  if (isLeft(kind)) return false;
  if (kind.right === "file" && descriptor.requireFileName) {
    const filename =
      descriptor.fileNameHeader === undefined
        ? part.disposition?.filename
        : part.headers.get(descriptor.fileNameHeader.toLowerCase());
    if (filename === undefined) return false;
    try {
      validateFileName(filename);
    } catch {
      return false;
    }
  }
  return true;
}

function decodeMultipartPart(
  descriptor: MultipartPartDescriptor,
  part: ParsedMultipartPart,
): DecoderResult<unknown> {
  const declared = descriptor.contentTypes ?? [];
  if (descriptor.requireContentType && !part.contentType) {
    return fail("", "Expected a multipart part Content-Type.");
  }
  if (
    part.contentType &&
    declared.length > 0 &&
    !isContentTypeAccepted(part.contentType, declared)
  ) {
    return fail(
      "",
      `Multipart part content type "${part.contentType}" is outside its declared contract.`,
    );
  }

  const decoders = descriptorDecoders(descriptor);
  const kind = selectMultipartPartKind(decoders, part.contentType);
  if (isLeft(kind)) return kind;
  const decoder = decoders[kind.right];
  if (!decoder) {
    return fail(
      "",
      `Multipart part content type ${JSON.stringify(part.contentType ?? null)} has no decoder.`,
    );
  }

  let wireValue: unknown;
  try {
    switch (kind.right) {
      case "text":
        wireValue = strictMultipartText(part.body);
        break;
      case "binary":
        wireValue = part.body;
        break;
      case "json":
        wireValue = parseJsonText(strictMultipartText(part.body));
        break;
      case "file":
        wireValue = multipartFile(descriptor, part);
        break;
    }
  } catch (error) {
    if (error instanceof MultipartSyntaxError) return fail("", error.message);
    return fail(
      "",
      kind.right === "json"
        ? "Multipart part must contain valid JSON."
        : "Multipart text part must contain valid UTF-8.",
    );
  }
  return decoder.decode(wireValue);
}

function descriptorDecoders(descriptor: MultipartPartDescriptor): MultipartPartDecoderMap {
  return descriptor.decoders ?? { [descriptor.kind]: descriptor.decoder };
}

function selectMultipartPartKind(
  decoders: MultipartPartDecoderMap,
  contentType: string | undefined,
): DecoderResult<MultipartPartKind> {
  const kinds = (Object.keys(decoders) as MultipartPartKind[]).filter(
    (kind) => decoders[kind] !== undefined,
  );
  if (kinds.length === 1) return succeed(kinds[0]!);

  const mediaKind = multipartMediaKind(contentType);
  if (mediaKind && decoders[mediaKind]) return succeed(mediaKind);
  if (!contentType && decoders.text) return succeed("text");
  if (!contentType) {
    return fail("", "Multipart part omits Content-Type, so its representation is ambiguous.");
  }
  return fail("", `Multipart part content type "${contentType}" has no matching decoder.`);
}

function multipartMediaKind(contentType: string | undefined): MultipartPartKind | undefined {
  if (!contentType) return undefined;
  if (contentType === "application/json" || contentType.endsWith("+json")) return "json";
  if (contentType.startsWith("text/")) return "text";
  return "binary";
}

function multipartFile(descriptor: MultipartPartDescriptor, part: ParsedMultipartPart): File {
  const relocated = descriptor.fileNameHeader;
  const filename =
    relocated === undefined
      ? part.disposition?.filename
      : part.headers.get(relocated.toLowerCase());
  if (filename === undefined && descriptor.requireFileName) {
    throw new MultipartSyntaxError(
      relocated === undefined
        ? "Multipart File is missing its filename parameter."
        : `Multipart File is missing its "${relocated.toLowerCase()}" filename header.`,
    );
  }
  const normalizedName = filename ?? "";
  validateFileName(normalizedName);
  return createFile(part.body, normalizedName, part.contentType ?? "");
}

function strictMultipartText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function isHeaderName(name: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);
}

export const Decoders = {
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
  encodedNumberString: encodedNumberStringDecoder,
  encodedIntegerString: encodedIntegerStringDecoder,
  encodedBigIntString: encodedBigIntStringDecoder,
  encodedBooleanString: encodedBooleanStringDecoder,
  rfc3339DateTime: rfc3339DateTimeDecoder,
  rfc7231DateTime: rfc7231DateTimeDecoder,
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
  multipartFormData: multipartFormDataDecoder,
  multipartTuple: multipartTupleDecoder,
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

/**
 * Optional shared body decode options.
 * - `contentTypes`: when non-empty, the request `Content-Type` is validated;
 *   requests whose header does not match any entry are rejected with a
 *   415 `UnsupportedMediaTypeError` before body parsing.
 * - `root`: path prefix used in validation issue paths (default `"$body"`).
 * - `optional`: when true, a request with no body succeeds with `undefined`
 *   before Content-Type validation (default `false`).
 * - `allowMissingContentType`: when true, an absent Content-Type is accepted
 *   while any present value is still checked against `contentTypes`.
 * - `maxRequestBodyBytes`: maximum streamed body bytes. `undefined` uses the
 *   finite runtime default (or inherits an enclosing router limit); a
 *   non-negative safe integer overrides it; `false` disables decoder-level
 *   enforcement but cannot weaken an enclosing router policy.
 * - `fileNameProperty` and `fileBodyProperty`: generated merge metadata used
 *   to mirror a relocated path, query, or header filename into `File.name`.
 */
export interface BodyDecodeOptions {
  readonly contentTypes?: readonly string[];
  readonly root?: string;
  readonly optional?: boolean;
  readonly allowMissingContentType?: boolean;
  readonly maxRequestBodyBytes?: RequestBodyLimit;
  readonly fileNameProperty?: string;
  readonly fileBodyProperty?: string;
}

export type BodyDecodeError =
  | ValidationError
  | UnsupportedMediaTypeError
  | RequestBodyTooLargeError;

export type BodyMediaKind = "json" | "form" | "multipart" | "file" | "text" | "binary";

/** Decoders generated for the wire representations accepted by one operation. */
export type BodyDecoderMap<A> = Readonly<Partial<Record<BodyMediaKind, Decoder<A>>>>;

/**
 * Parses and validates a request body according to its received Content-Type.
 * The decoder map keeps JSON validation strict while allowing textual HTTP
 * representations (forms, multipart fields, and text bodies) to coerce scalars.
 */
export function decodeBody<A>(
  request: Request,
  decoders: BodyDecoderMap<A>,
  options: BodyDecodeOptions & { readonly optional: true },
): Promise<EitherT<BodyDecodeError, A | undefined>>;
export function decodeBody<A>(
  request: Request,
  decoders: BodyDecoderMap<A>,
  options?: BodyDecodeOptions & { readonly optional?: false },
): Promise<EitherT<BodyDecodeError, A>>;
export function decodeBody<A>(
  request: Request,
  decoders: BodyDecoderMap<A>,
  options?: BodyDecodeOptions,
): Promise<EitherT<BodyDecodeError, A | undefined>>;
export async function decodeBody<A>(
  request: Request,
  decoders: BodyDecoderMap<A>,
  options: BodyDecodeOptions = {},
): Promise<EitherT<BodyDecodeError, A | undefined>> {
  const limitedRequest = requestForBodyDecoding(request, options.maxRequestBodyBytes);
  if (isLeft(limitedRequest)) return limitedRequest;
  request = limitedRequest.right;

  const root = options.root ?? "$body";
  const initialKind = selectBodyMediaKind(decoders, request.headers.get("content-type"));
  if (initialKind === "file") {
    if (options.optional && request.body === null) return Either.right(undefined);

    const contentTypeError = checkContentType(
      request,
      options.contentTypes,
      options.allowMissingContentType,
    );
    if (contentTypeError) return Either.left(contentTypeError);

    if (request.body === null) {
      return Either.left(
        new ValidationError([{ path: root, message: "Required body is missing." }]),
      );
    }
  }

  let bodyRequest = request;
  let abandonProbedBody: (() => void) | undefined;
  if (options.optional && initialKind !== "file") {
    try {
      const presentBody = await requestWithPresentBody(request);
      if (!presentBody) return Either.right(undefined);
      bodyRequest = presentBody.request;
      abandonProbedBody = presentBody.abandon;
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) return Either.left(error);
      const parser =
        BODY_PARSERS[selectBodyMediaKind(decoders, request.headers.get("content-type"))];
      return Either.left(new ValidationError([{ path: root, message: parser.failureMessage }]));
    }
  }

  const ctError =
    initialKind === "file"
      ? undefined
      : checkContentType(bodyRequest, options.contentTypes, options.allowMissingContentType);
  if (ctError) {
    abandonProbedBody?.();
    return Either.left(ctError);
  }

  const kind = selectBodyMediaKind(decoders, bodyRequest.headers.get("content-type"));
  const decoder = decoders[kind];
  if (!decoder) {
    abandonProbedBody?.();
    return Either.left(
      new UnsupportedMediaTypeError(
        bodyRequest.headers.get("content-type") ?? undefined,
        supportedMediaTypes(decoders),
      ),
    );
  }

  const parser = BODY_PARSERS[kind];
  try {
    return await decodeParsedBody(
      bodyRequest,
      decoder,
      { ...options, root },
      parser.parse,
      parser.failureMessage,
      true,
    );
  } finally {
    abandonProbedBody?.();
  }
}

interface PresentBodyRequest {
  readonly request: Request;
  /** Releases the probe's reader without canceling the underlying request. */
  readonly abandon: () => void;
}

/**
 * Distinguishes an empty streaming body from a present body without buffering
 * the payload. The first non-empty chunk is replayed into a replacement
 * Request so normal parsing can continue from the same stream.
 */
async function requestWithPresentBody(request: Request): Promise<PresentBodyRequest | undefined> {
  if (request.body === null) return undefined;

  const reader = request.body.getReader();
  let firstChunk: Uint8Array | undefined;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        reader.releaseLock();
        return undefined;
      }
      if (next.value.byteLength > 0) {
        firstChunk = next.value;
        break;
      }
    }
  } catch (error) {
    reader.releaseLock();
    throw error;
  }

  let released = false;
  let reading = false;
  let abandoned = false;
  let replayController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const release = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  const releaseAbandonedProbe = () => {
    release();
    releaseRequestBodyLimit(request);
  };
  const replayBody = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        replayController = controller;
      },
      async pull(controller) {
        if (abandoned) {
          if (!reading) releaseAbandonedProbe();
          return;
        }
        if (firstChunk) {
          const chunk = firstChunk;
          firstChunk = undefined;
          controller.enqueue(chunk);
          return;
        }

        try {
          reading = true;
          const next = await reader.read();
          reading = false;
          if (abandoned) {
            releaseAbandonedProbe();
            return;
          }
          if (next.done) {
            release();
            controller.close();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          reading = false;
          release();
          if (!abandoned) controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          release();
        }
      },
    },
    {
      // Only replay when the selected parser starts consuming the body.
      highWaterMark: 0,
    },
  );

  const replayRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: replayBody,
    signal: request.signal,
    // @ts-expect-error duplex is required for streaming bodies in Node.
    duplex: "half",
  });
  inheritRequestBodyLimit(request, replayRequest);

  return {
    request: replayRequest,
    abandon() {
      if (abandoned) return;
      abandoned = true;
      firstChunk = undefined;
      try {
        replayController?.close();
      } catch {
        // The parser may already have closed or errored the replay stream.
      }
      if (!reading) {
        releaseAbandonedProbe();
      }
    },
  };
}

/** Parses and validates the request JSON body. */
export function decodeJsonBody<A>(
  request: Request,
  decoder: Decoder<A>,
  options: BodyDecodeOptions & { readonly optional: true },
): Promise<EitherT<BodyDecodeError, A | undefined>>;
export function decodeJsonBody<A>(
  request: Request,
  decoder: Decoder<A>,
  options?: BodyDecodeOptions & { readonly optional?: false },
): Promise<EitherT<BodyDecodeError, A>>;
export function decodeJsonBody<A>(
  request: Request,
  decoder: Decoder<A>,
  options?: BodyDecodeOptions,
): Promise<EitherT<BodyDecodeError, A | undefined>>;
export async function decodeJsonBody<A>(
  request: Request,
  decoder: Decoder<A>,
  options: BodyDecodeOptions = {},
): Promise<EitherT<BodyDecodeError, A | undefined>> {
  const limitedRequest = requestForBodyDecoding(request, options.maxRequestBodyBytes);
  if (isLeft(limitedRequest)) return limitedRequest;
  request = limitedRequest.right;

  const root = options.root ?? "$body";
  let bodyRequest = request;
  let abandonProbedBody: (() => void) | undefined;
  if (options.optional) {
    try {
      const presentBody = await requestWithPresentBody(request);
      if (!presentBody) return Either.right(undefined);
      bodyRequest = presentBody.request;
      abandonProbedBody = presentBody.abandon;
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) return Either.left(error);
      return Either.left(
        new ValidationError([{ path: root, message: "Body must contain valid JSON." }]),
      );
    }
  }

  try {
    return await decodeParsedBody(
      bodyRequest,
      decoder,
      { ...options, root },
      parseJsonBody,
      "Body must contain valid JSON.",
    );
  } finally {
    abandonProbedBody?.();
  }
}

/** Parses and validates a URL-encoded form body. */
export function decodeFormBody<A>(
  request: Request,
  decoder: Decoder<A>,
  options: BodyDecodeOptions = {},
): Promise<EitherT<BodyDecodeError, A>> {
  return decodeParsedBody(
    request,
    decoder,
    options,
    parseFormBody,
    "Body must contain valid form data.",
  );
}

/** Parses and validates a MIME multipart body. */
export function decodeMultipartBody<A>(
  request: Request,
  decoder: Decoder<A>,
  options: BodyDecodeOptions = {},
): Promise<EitherT<BodyDecodeError, A>> {
  return decodeParsedBody(
    request,
    decoder,
    options,
    parseMultipartBody,
    "Body must contain valid multipart MIME data.",
  );
}

async function decodeParsedBody<A>(
  request: Request,
  decoder: Decoder<A>,
  options: BodyDecodeOptions,
  parse: (request: Request, options: BodyDecodeOptions) => Promise<unknown>,
  parseFailureMessage: string,
  contentTypeChecked = false,
): Promise<EitherT<BodyDecodeError, A>> {
  const limitedRequest = requestForBodyDecoding(request, options.maxRequestBodyBytes);
  if (isLeft(limitedRequest)) return limitedRequest;
  request = limitedRequest.right;

  const root = options.root ?? "$body";
  if (!contentTypeChecked) {
    const ctError = checkContentType(
      request,
      options.contentTypes,
      options.allowMissingContentType,
    );
    if (ctError) return Either.left(ctError);
  }

  let value: unknown;
  try {
    value = await parse(request, options);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return Either.left(error);
    return Either.left(
      new ValidationError([
        {
          path: root,
          message: error instanceof MultipartSyntaxError ? error.message : parseFailureMessage,
        },
      ]),
    );
  }
  return toValidationResult(decoder.decode(value), root);
}

function requestForBodyDecoding(
  request: Request,
  maximum: RequestBodyLimit | undefined,
): EitherT<RequestBodyTooLargeError, Request> {
  try {
    return Either.right(enforceRequestBodyLimit(request, maximum));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return Either.left(error);
    throw error;
  }
}

async function parseJsonBody(request: Request): Promise<unknown> {
  return parseJsonText(await request.text());
}

function parseJsonText(text: string): unknown {
  const nativeValue = JSON.parse(text) as unknown;
  const preciseValue = parseLosslessJson(text, undefined, { parseNumber: parseJsonNumber });
  return rebuildJsonValue(nativeValue, preciseValue);
}

function parseJsonNumber(value: string): number | bigint {
  if (DECIMAL_INTEGER_PATTERN.test(value)) {
    const digitCount = value[0] === "-" ? value.length - 1 : value.length;
    if (digitCount > MAX_LOSSLESS_JSON_INTEGER_DIGITS) {
      throw new SyntaxError(
        `JSON integers may contain at most ${MAX_LOSSLESS_JSON_INTEGER_DIGITS} digits.`,
      );
    }
    const numberValue = Number(value);
    return Number.isSafeInteger(numberValue) ? numberValue : BigInt(value);
  }
  return Number(value);
}

/**
 * Rebuilds from native JSON's safe object shape while taking numeric leaves
 * from the lossless parse. This avoids special keys such as `__proto__`
 * changing object prototypes inside third-party parser output.
 */
function rebuildJsonValue(nativeValue: unknown, preciseValue: unknown): unknown {
  if (typeof nativeValue === "number") return preciseValue;
  if (Array.isArray(nativeValue)) {
    const preciseItems = Array.isArray(preciseValue) ? preciseValue : [];
    return nativeValue.map((item, index) => rebuildJsonValue(item, preciseItems[index]));
  }
  if (typeof nativeValue !== "object" || nativeValue === null) return nativeValue;

  const nativeObject = nativeValue as Record<string, unknown>;
  const preciseObject = preciseValue as Record<string, unknown> | null;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(nativeObject)) {
    const matchingValue =
      preciseObject && Object.prototype.hasOwnProperty.call(preciseObject, key)
        ? preciseObject[key]
        : nativeObject[key];
    defineDataProperty(result, key, rebuildJsonValue(nativeObject[key], matchingValue));
  }
  return result;
}

function parseTextBody(request: Request): Promise<string> {
  return request.text();
}

async function parseBinaryBody(request: Request): Promise<Uint8Array> {
  return new Uint8Array(await request.arrayBuffer());
}

async function parseFormBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  return collectBodyFields(new URLSearchParams(text));
}

async function parseMultipartBody(request: Request): Promise<Record<string, unknown>> {
  const parsed = await parseMultipartRequest(request);
  const legacy = collectLegacyMultipartFields(parsed);
  Object.defineProperty(legacy, MULTIPART_BODY, {
    configurable: false,
    enumerable: false,
    value: parsed,
    writable: false,
  });
  return legacy as MultipartDecoderInput;
}

async function parseFileBody(request: Request): Promise<File> {
  const contentType = parseMediaType(request.headers.get("content-type")) ?? "";
  return createFile(new Uint8Array(await request.arrayBuffer()), "", contentType);
}

function createFile(contents: Uint8Array, name: string, contentType: string): File {
  const ownedContents = new ArrayBuffer(contents.byteLength);
  new Uint8Array(ownedContents).set(contents);
  const file = new File([ownedContents], name, { type: contentType });
  // Bun currently omits `.name` for an empty filename; normalize to the Web
  // File contract so handlers see the same sentinel in every runtime.
  if (file.name !== name) {
    Object.defineProperty(file, "name", { value: name, enumerable: true });
  }
  if (file.type !== contentType) {
    Object.defineProperty(file, "type", { value: contentType, enumerable: true });
  }
  return file;
}

function collectLegacyMultipartFields(body: ParsedMultipartBody): Record<string, unknown> {
  const value: Record<string, unknown> = Object.create(null);
  for (const part of body.parts) {
    const disposition = part.disposition;
    if (disposition?.type !== "form-data" || !disposition.name) continue;

    let partValue: unknown;
    if (disposition.filename !== undefined) {
      partValue = createFile(part.body, disposition.filename, part.contentType ?? "");
    } else {
      partValue = new TextDecoder().decode(part.body);
    }
    appendBodyField(value, disposition.name, partValue);
  }
  return value;
}

const BODY_PARSERS: Readonly<
  Record<
    BodyMediaKind,
    {
      readonly parse: (request: Request, options: BodyDecodeOptions) => Promise<unknown>;
      readonly failureMessage: string;
    }
  >
> = {
  json: { parse: parseJsonBody, failureMessage: "Body must contain valid JSON." },
  form: { parse: parseFormBody, failureMessage: "Body must contain valid form data." },
  multipart: {
    parse: parseMultipartBody,
    failureMessage: "Body must contain valid multipart MIME data.",
  },
  file: { parse: parseFileBody, failureMessage: "Body must contain valid file content." },
  text: { parse: parseTextBody, failureMessage: "Body must contain valid text." },
  binary: { parse: parseBinaryBody, failureMessage: "Body must contain valid binary data." },
};

function bodyMediaKind(contentType: string | null): BodyMediaKind {
  const mediaType = parseMediaType(contentType);
  if (!mediaType || mediaType === "application/json" || mediaType.endsWith("+json")) {
    return "json";
  }
  if (mediaType === "application/x-www-form-urlencoded") return "form";
  if (mediaType.startsWith("multipart/")) return "multipart";
  if (mediaType.startsWith("text/")) return "text";
  return "binary";
}

function selectBodyMediaKind<A>(
  decoders: BodyDecoderMap<A>,
  contentType: string | null,
): BodyMediaKind {
  return decoders.file ? "file" : bodyMediaKind(contentType);
}

function supportedMediaTypes<A>(decoders: BodyDecoderMap<A>): string[] {
  const supported: string[] = [];
  if (decoders.json) supported.push("application/json");
  if (decoders.form) supported.push("application/x-www-form-urlencoded");
  if (decoders.multipart) supported.push("multipart/form-data");
  if (decoders.file) supported.push("*/*");
  if (decoders.text) supported.push("text/*");
  if (decoders.binary) supported.push("application/octet-stream");
  return supported;
}

function collectBodyFields(entries: Iterable<readonly [string, unknown]>): Record<string, unknown> {
  const value: Record<string, unknown> = Object.create(null);
  for (const [key, val] of entries) {
    appendBodyField(value, key, val);
  }
  return value;
}

function checkContentType(
  request: Request,
  declared: readonly string[] | undefined,
  allowMissing = false,
): UnsupportedMediaTypeError | undefined {
  if (!declared || declared.length === 0) return undefined;
  const received = request.headers.get("content-type");
  if (allowMissing && received === null) return undefined;
  if (isContentTypeAccepted(received, declared)) return undefined;
  return new UnsupportedMediaTypeError(received ?? undefined, declared);
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

/** Parses and validates the request JSON body, throws on failure. */
export function decodeJsonBodyOrThrow<A>(
  request: Request,
  decoder: Decoder<A>,
  options: BodyDecodeOptions & { readonly optional: true },
): Promise<A | undefined>;
export function decodeJsonBodyOrThrow<A>(
  request: Request,
  decoder: Decoder<A>,
  options?: BodyDecodeOptions & { readonly optional?: false },
): Promise<A>;
export function decodeJsonBodyOrThrow<A>(
  request: Request,
  decoder: Decoder<A>,
  options?: BodyDecodeOptions,
): Promise<A | undefined>;
export async function decodeJsonBodyOrThrow<A>(
  request: Request,
  decoder: Decoder<A>,
  options: BodyDecodeOptions = {},
): Promise<A | undefined> {
  return Either.getOrElseThrow(await decodeJsonBody(request, decoder, options));
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

function appendBodyField(target: Record<string, unknown>, key: string, value: unknown): void {
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
