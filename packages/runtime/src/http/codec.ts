import { Either, isLeft, type Either as EitherT } from "../core/either.js";
import { HttpError } from "../errors.js";

/** One validation problem collected while decoding request input. */
export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** Structured 400 error raised at the boundary when request input fails validation. */
export class ValidationError extends HttpError {
  constructor(
    public readonly issues: readonly ValidationIssue[],
    message = "Invalid request",
  ) {
    super(400, message, { error: message, issues });
    this.name = "ValidationError";
  }
}

/** Internal codec result — lightweight issue array, no Error allocation. */
export type CodecResult<A> = EitherT<readonly ValidationIssue[], A>;

/**
 * FP-style runtime codec that validates one input value into `A`.
 *
 * Codecs are path-free: errors carry relative path segments (e.g. `""`,
 * `".field"`, `"[0]"`).  Boundary functions prefix a root such as `"$"`.
 *
 * Returns `Either<ValidationIssue[], A>` — lightweight arrays, no Error objects.
 * Only boundary functions (`decode`, `decodeJsonBody`) wrap in `ValidationError`.
 */
export interface Codec<A> {
  decode(input: unknown): CodecResult<A>;
}

/** Codec combinator for optional values. Accepts `undefined` (absent fields), delegates the rest. */
export function optional<A>(codec: Codec<A>): Codec<A | undefined> {
  return {
    decode(input) {
      if (input === undefined) return RIGHT_UNDEF;
      return codec.decode(input);
    },
  };
}

// ---------------------------------------------------------------------------
// Pre-allocated constants — avoid allocations on the hot path
// ---------------------------------------------------------------------------

const RIGHT_TRUE: CodecResult<boolean> = Either.right(true);
const RIGHT_FALSE: CodecResult<boolean> = Either.right(false);
const RIGHT_NULL: CodecResult<null> = Either.right(null);
const RIGHT_UNDEF: CodecResult<undefined> = Either.right(undefined);

// ---------------------------------------------------------------------------
// Codec result helpers — work with raw issue arrays, no Error allocation
// ---------------------------------------------------------------------------

/** Wraps a decoded value in a successful result. */
export function succeed<A>(value: A): CodecResult<A> {
  return Either.right(value);
}

/** Creates a single-issue failure with a relative path. */
export function fail(path: string, message: string): CodecResult<never> {
  return Either.left([{ path, message }]);
}

/** Creates a multi-issue failure. */
function failMany(issues: readonly ValidationIssue[]): CodecResult<never> {
  return Either.left(issues);
}

function expectPlainObject(
  input: unknown,
): CodecResult<Record<string, unknown>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail("", "Expected an object.");
  }
  return succeed(input as Record<string, unknown>);
}

/** Prefix every issue path in a Left with `prefix`. Identity on Right. */
export function prefixIssues<A>(
  either: CodecResult<A>,
  prefix: string,
): CodecResult<A> {
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
  f: (item: A, index: number) => CodecResult<B>,
): CodecResult<B[]> {
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
// Primitive codecs
// ---------------------------------------------------------------------------

export const stringCodec: Codec<string> = {
  decode(input) {
    if (typeof input === "string") return succeed(input);
    return fail("", "Expected a string.");
  },
};

export const numberCodec: Codec<number> = {
  decode(input) {
    if (typeof input === "number" && Number.isFinite(input)) return succeed(input);
    if (typeof input === "string") {
      const parsed = Number(input);
      if (Number.isFinite(parsed)) return succeed(parsed);
    }
    return fail("", "Expected a finite number.");
  },
};

export const bigintCodec: Codec<bigint> = {
  decode(input) {
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
  },
};

export const booleanCodec: Codec<boolean> = {
  decode(input) {
    if (input === true) return RIGHT_TRUE;
    if (input === false) return RIGHT_FALSE;
    if (input === "true") return RIGHT_TRUE;
    if (input === "false") return RIGHT_FALSE;
    return fail("", 'Expected "true" or "false".');
  },
};

export const bytesCodec: Codec<Uint8Array> = {
  decode(input) {
    if (input instanceof Uint8Array) return succeed(input);
    if (typeof input === "string") return decodeBase64(input);
    if (Array.isArray(input)) return decodeByteArray(input);
    return fail("", "Expected a base64 string or byte array.");
  },
};

export const unknownCodec: Codec<unknown> = {
  decode(input) {
    return succeed(input);
  },
};

// ---------------------------------------------------------------------------
// Combinator codecs
// ---------------------------------------------------------------------------

export function literalCodec<A extends string | number | boolean | null>(
  value: A,
): Codec<A> {
  return {
    decode(input) {
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
    },
  };
}

/** Strict literal codec for JSON contexts — no string coercion. */
export function strictLiteralCodec<A extends string | number | boolean | null>(
  value: A,
): Codec<A> {
  return {
    decode(input) {
      if (input === value) return succeed(value);
      return fail("", `Expected literal ${JSON.stringify(value)}.`);
    },
  };
}

/**
 * Array codec for text contexts (query params, headers).
 * Coerces a lone string into a 1-element array — standard HTTP behavior.
 */
export function arrayCodec<A>(item: Codec<A>): Codec<A[]> {
  return {
    decode(input) {
      const values = Array.isArray(input) ? input : typeof input === "string" ? [input] : null;
      if (values == null) return fail("", "Expected an array.");

      return decodeArrayItems(item, values);
    },
  };
}

/**
 * Strict array codec for JSON contexts.
 * Rejects non-array inputs — no string-to-array coercion.
 */
export function strictArrayCodec<A>(item: Codec<A>): Codec<A[]> {
  return {
    decode(input) {
      if (!Array.isArray(input)) return fail("", "Expected an array.");

      return decodeArrayItems(item, input);
    },
  };
}

function decodeArrayItems<A>(
  item: Codec<A>,
  values: readonly unknown[],
): CodecResult<A[]> {
  return traverseEither(values, (value, index) => {
    const decoded = item.decode(value);
    return isLeft(decoded) ? prefixIssues(decoded, `[${index}]`) : decoded;
  });
}

export function tupleCodec<A extends readonly unknown[]>(
  items: readonly Codec<any>[],
): Codec<A> {
  return {
    decode(input) {
      if (!Array.isArray(input)) return fail("", "Expected an array.");
      if (input.length !== items.length) {
        return fail("", `Expected a tuple of length ${items.length}.`);
      }

      return traverseEither(items, (codec, index) => {
        const decoded = codec.decode(input[index]);
        return isLeft(decoded) ? prefixIssues(decoded, `[${index}]`) : decoded;
      }) as CodecResult<A>;
    },
  };
}

export function recordCodec<A>(value: Codec<A>): Codec<Record<string, A>> {
  return {
    decode(input) {
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
    },
  };
}

export function objectCodec<A>(
  fields: Readonly<Record<string, Codec<any>>>,
  options?: { allowUnknown?: boolean },
): Codec<A> {
  const fieldEntries = Object.entries(fields).map(
    ([name, codec]) => [name, codec] as const,
  );
  const allowUnknown = options?.allowUnknown ?? false;

  return {
    decode(input) {
      const object = expectPlainObject(input);
      if (isLeft(object)) return object;

      const result: Record<string, unknown> = {};
      let issues: ValidationIssue[] | null = null;

      for (const [fieldName, codec] of fieldEntries) {
        const decoded = codec.decode(object.right[fieldName]);
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
    },
  };
}

export function unionCodec<A>(
  variants: readonly Codec<any>[],
): Codec<A> {
  return {
    decode(input) {
      for (const variant of variants) {
        const decoded = variant.decode(input);
        if (!isLeft(decoded)) return decoded;
      }
      return fail("", "Value did not match any allowed variant.");
    },
  };
}

export function nullableCodec<A>(inner: Codec<A>): Codec<A | null> {
  return {
    decode(input) {
      if (input === null || input === "null") return RIGHT_NULL as CodecResult<A | null>;
      return inner.decode(input);
    },
  };
}

/** Strict nullable for JSON — only accepts actual `null`, not the string `"null"`. */
export function strictNullableCodec<A>(inner: Codec<A>): Codec<A | null> {
  return {
    decode(input) {
      if (input === null) return RIGHT_NULL as CodecResult<A | null>;
      return inner.decode(input);
    },
  };
}

export function lazyCodec<A>(resolve: () => Codec<A>): Codec<A> {
  let resolved: Codec<A> | undefined;
  return {
    decode(input) {
      resolved ??= resolve();
      return resolved.decode(input);
    },
  };
}

/** O(1) dispatch for discriminated unions — checks one field, looks up the variant. */
export function discriminatedCodec<A>(
  discriminator: string,
  variants: Readonly<Record<string, Codec<A>>>,
): Codec<A> {
  return {
    decode(input) {
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
    },
  };
}

// ---------------------------------------------------------------------------
// Codec transformers
// ---------------------------------------------------------------------------

/** Functor map for codecs — transform the decoded value. */
export function mapCodec<A, B>(codec: Codec<A>, f: (a: A) => B): Codec<B> {
  return {
    decode(input) {
      return Either.map(codec.decode(input), f);
    },
  };
}

/** Refine a codec with a predicate — for @minValue, @maxLength, etc. */
export function refineCodec<A>(
  codec: Codec<A>,
  predicate: (value: A) => boolean,
  message: string | ((value: A) => string),
): Codec<A> {
  return {
    decode(input) {
      return Either.flatMap(codec.decode(input), (value) =>
        predicate(value)
          ? succeed(value)
          : fail("", typeof message === "function" ? message(value) : message),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Boundary functions — these create ValidationError at the exit
// ---------------------------------------------------------------------------

/** Converts a codec result (issue array) to Either<ValidationError, A> with path prefix. */
export function toValidationResult<A>(
  result: CodecResult<A>,
  root: string,
): EitherT<ValidationError, A> {
  if (!isLeft(result)) return result;
  const prefixed = result.left.map((i) => ({ path: root + i.path, message: i.message }));
  return Either.left(new ValidationError(prefixed));
}

/**
 * Decodes one value via a codec, prefixes paths, wraps errors in ValidationError.
 */
export function decode<A>(
  codec: Codec<A>,
  input: unknown,
  root = "$",
): EitherT<ValidationError, A> {
  return toValidationResult(codec.decode(input), root);
}

/** Decodes one required value (rejects null/undefined). */
export function decodeRequired<A>(
  codec: Codec<A>,
  input: unknown,
): CodecResult<A> {
  if (input === undefined || input === null) {
    return fail("", "Required value is missing.");
  }
  return codec.decode(input);
}

/** Decodes one optional value (null/undefined become `undefined`). */
export function decodeOptional<A>(
  codec: Codec<A>,
  input: unknown,
): CodecResult<A | undefined> {
  if (input === undefined || input === null) {
    return RIGHT_UNDEF;
  }
  return codec.decode(input);
}

/** Parses and validates the request JSON body. Returns Either<ValidationError, A>. */
export async function decodeJsonBody<A>(
  request: Request,
  codec: Codec<A>,
  root = "$body",
): Promise<EitherT<ValidationError, A>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return Either.left(new ValidationError([{ path: root, message: "Body must contain valid JSON." }]));
  }
  return toValidationResult(codec.decode(value), root);
}

/** Decodes one value and throws `ValidationError` on failure. */
export function decodeOrThrow<A>(
  codec: Codec<A>,
  input: unknown,
  root = "$",
): A {
  return Either.getOrElseThrow(decode(codec, input, root));
}

/** Decodes one required value and throws on failure. */
export function decodeRequiredOrThrow<A>(
  codec: Codec<A>,
  input: unknown,
  path: string,
): A {
  return Either.getOrElseThrow(toValidationResult(decodeRequired(codec, input), path));
}

/** Decodes one optional value and throws on failure. */
export function decodeOptionalOrThrow<A>(
  codec: Codec<A>,
  input: unknown,
  path: string,
): A | undefined {
  return Either.getOrElseThrow(toValidationResult(decodeOptional(codec, input), path));
}

/** Parses and validates the request JSON body, throws on failure. */
export async function decodeJsonBodyOrThrow<A>(
  request: Request,
  codec: Codec<A>,
  root = "$body",
): Promise<A> {
  return Either.getOrElseThrow(await decodeJsonBody(request, codec, root));
}

// ---------------------------------------------------------------------------
// Private byte helpers
// ---------------------------------------------------------------------------

function decodeByteArray(
  input: unknown[],
): CodecResult<Uint8Array> {
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
): CodecResult<Uint8Array> {
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
