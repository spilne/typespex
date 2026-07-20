import { Either, isLeft, type Either as EitherT } from "../core/either.js";
import { parse as parseLosslessJson } from "lossless-json";
import { isContentTypeAccepted, parseMediaType } from "./media-type.js";
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
      const inputValue = Object.prototype.hasOwnProperty.call(object.right, fieldName)
        ? object.right[fieldName]
        : undefined;
      const decoded = decoder.decode(inputValue);
      if (isLeft(decoded)) {
        for (const issue of decoded.left) {
          (issues ??= []).push({
            path: `.${fieldName}${issue.path}`,
            message: issue.message,
          });
        }
      } else if (decoded.right !== undefined) {
        defineDataProperty(result, fieldName, decoded.right);
      }
    }

    if (!allowUnknown) {
      for (const key of Object.keys(object.right)) {
        if (!Object.prototype.hasOwnProperty.call(fields, key)) {
          (issues ??= []).push({ path: `.${key}`, message: "Unexpected field." });
        }
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
    const variant = key !== undefined ? variants[key] : undefined;
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
  file: fileDecoder,
  unknown: unknownDecoder,
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

/**
 * Optional shared body decode options.
 * - `contentTypes`: when non-empty, the request `Content-Type` is validated;
 *   requests whose header does not match any entry are rejected with a
 *   415 `UnsupportedMediaTypeError` before body parsing.
 * - `root`: path prefix used in validation issue paths (default `"$body"`).
 * - `optional`: when true, a request with no body succeeds with `undefined`
 *   before Content-Type validation (default `false`).
 */
export interface BodyDecodeOptions {
  readonly contentTypes?: readonly string[];
  readonly root?: string;
  readonly optional?: boolean;
}

export type BodyDecodeError = ValidationError | UnsupportedMediaTypeError;

export type BodyMediaKind = "json" | "form" | "multipart" | "text" | "binary";

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
  const root = options.root ?? "$body";
  let bodyRequest = request;
  let abandonProbedBody: (() => void) | undefined;
  if (options.optional) {
    try {
      const presentBody = await requestWithPresentBody(request);
      if (!presentBody) return Either.right(undefined);
      bodyRequest = presentBody.request;
      abandonProbedBody = presentBody.abandon;
    } catch {
      const parser = BODY_PARSERS[bodyMediaKind(request.headers.get("content-type"))];
      return Either.left(new ValidationError([{ path: root, message: parser.failureMessage }]));
    }
  }

  const ctError = checkContentType(bodyRequest, options.contentTypes);
  if (ctError) {
    abandonProbedBody?.();
    return Either.left(ctError);
  }

  const kind = bodyMediaKind(bodyRequest.headers.get("content-type"));
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
  const replayBody = new ReadableStream<Uint8Array>({
    start(controller) {
      replayController = controller;
    },
    async pull(controller) {
      if (abandoned) {
        if (!reading) release();
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
          release();
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
  });

  return {
    request: new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: replayBody,
      signal: request.signal,
      // @ts-expect-error duplex is required for streaming bodies in Node.
      duplex: "half",
    }),
    abandon() {
      if (abandoned) return;
      abandoned = true;
      firstChunk = undefined;
      try {
        replayController?.close();
      } catch {
        // The parser may already have closed or errored the replay stream.
      }
      if (!reading) release();
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
  const root = options.root ?? "$body";
  let bodyRequest = request;
  let abandonProbedBody: (() => void) | undefined;
  if (options.optional) {
    try {
      const presentBody = await requestWithPresentBody(request);
      if (!presentBody) return Either.right(undefined);
      bodyRequest = presentBody.request;
      abandonProbedBody = presentBody.abandon;
    } catch {
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

/** Parses and validates a multipart/form-data body. */
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
    "Body must contain valid multipart form data.",
  );
}

async function decodeParsedBody<A>(
  request: Request,
  decoder: Decoder<A>,
  options: BodyDecodeOptions,
  parse: (request: Request) => Promise<unknown>,
  parseFailureMessage: string,
  contentTypeChecked = false,
): Promise<EitherT<BodyDecodeError, A>> {
  const root = options.root ?? "$body";
  if (!contentTypeChecked) {
    const ctError = checkContentType(request, options.contentTypes);
    if (ctError) return Either.left(ctError);
  }

  let value: unknown;
  try {
    value = await parse(request);
  } catch {
    return Either.left(new ValidationError([{ path: root, message: parseFailureMessage }]));
  }
  return toValidationResult(decoder.decode(value), root);
}

async function parseJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
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
  const formData = await request.formData();
  return collectBodyFields(formData);
}

const BODY_PARSERS: Readonly<
  Record<
    BodyMediaKind,
    {
      readonly parse: (request: Request) => Promise<unknown>;
      readonly failureMessage: string;
    }
  >
> = {
  json: { parse: parseJsonBody, failureMessage: "Body must contain valid JSON." },
  form: { parse: parseFormBody, failureMessage: "Body must contain valid form data." },
  multipart: {
    parse: parseMultipartBody,
    failureMessage: "Body must contain valid multipart form data.",
  },
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

function supportedMediaTypes<A>(decoders: BodyDecoderMap<A>): string[] {
  const supported: string[] = [];
  if (decoders.json) supported.push("application/json");
  if (decoders.form) supported.push("application/x-www-form-urlencoded");
  if (decoders.multipart) supported.push("multipart/form-data");
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
): UnsupportedMediaTypeError | undefined {
  if (!declared || declared.length === 0) return undefined;
  const received = request.headers.get("content-type");
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
