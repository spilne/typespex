import {
  ScalarEncodings,
  type DurationNumericUnit,
  type NumericWireEncoding,
} from "./scalar-encoding.js";
import type { Validator } from "./validation.js";

/** Error raised when a handler result cannot be converted to its declared JSON wire shape. */
export class JsonSerializationError extends TypeError {
  constructor(
    readonly path: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${path}: ${message}`, options);
    this.name = "JsonSerializationError";
  }
}

/** Converts one handler-facing value into a JSON wire value. */
export abstract class JsonSerializer<A> {
  abstract serialize(value: A, path?: string): unknown;

  static of<A>(serialize: (value: A, path: string) => unknown): JsonSerializer<A> {
    return new FunctionJsonSerializer(serialize);
  }
}

class FunctionJsonSerializer<A> extends JsonSerializer<A> {
  constructor(private readonly serializeValue: (value: A, path: string) => unknown) {
    super();
  }

  serialize(value: A, path = "$response"): unknown {
    return this.serializeValue(value, path);
  }
}

type JsonObjectProperty<A extends object> = {
  readonly [K in Extract<keyof A, string>]-?: {
    readonly property: K;
    readonly wireName: string;
    readonly serializer: JsonSerializer<Exclude<A[K], undefined>>;
    readonly optional?: boolean;
  };
}[Extract<keyof A, string>];

type JsonAdditionalProperty<A extends object> = string extends keyof A
  ? Exclude<A[string & keyof A], undefined>
  : unknown;

export interface JsonObjectSerializerOptions<A extends object> {
  /** Serializer for modeled additional properties. Unmodeled properties are otherwise omitted. */
  readonly additionalProperties?: JsonSerializer<JsonAdditionalProperty<A>>;
}

export interface JsonDiscriminatedSerializerOptions<A> {
  /** Serializer used when a string/number discriminator has no named variant. */
  readonly defaultVariant?: JsonSerializer<A>;
}

interface ErasedJsonObjectProperty {
  readonly property: string;
  readonly wireName: string;
  readonly serializer: JsonSerializer<unknown>;
  readonly optional: boolean;
}

const identitySerializer: JsonSerializer<unknown> = JsonSerializer.of((value) => value);

function identityJsonSerializer<A>(): JsonSerializer<A> {
  return identitySerializer as JsonSerializer<A>;
}

function literalJsonSerializer<A extends string | number | bigint | boolean | null>(
  expected: A,
): JsonSerializer<A> {
  return JsonSerializer.of((value, path) => {
    if (!Object.is(value, expected)) {
      const literal = typeof expected === "bigint" ? `${expected}n` : JSON.stringify(expected);
      throw new JsonSerializationError(path, `Expected literal ${literal}.`);
    }
    return value;
  });
}

function arrayJsonSerializer<A>(item: JsonSerializer<A>): JsonSerializer<readonly A[]> {
  return JsonSerializer.of((value, path) => {
    if (!Array.isArray(value)) {
      throw new JsonSerializationError(path, "Expected an array.");
    }

    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      // Preserve JSON.stringify's established sparse-array behavior.
      output.push(
        Object.prototype.hasOwnProperty.call(value, index)
          ? serializeNested(item, value[index]!, `${path}[${index}]`)
          : null,
      );
    }
    return output;
  });
}

function tupleJsonSerializer<A extends readonly unknown[]>(items: {
  readonly [K in keyof A]: JsonSerializer<A[K]>;
}): JsonSerializer<A> {
  return JsonSerializer.of((value, path) => {
    if (!Array.isArray(value)) {
      throw new JsonSerializationError(path, "Expected an array.");
    }
    if (value.length !== items.length) {
      throw new JsonSerializationError(path, `Expected a tuple of length ${items.length}.`);
    }
    return items.map((item, index) => serializeNested(item, value[index], `${path}[${index}]`));
  });
}

function recordJsonSerializer<A>(
  valueSerializer: JsonSerializer<A>,
): JsonSerializer<Record<string, A>> {
  return JsonSerializer.of((value, path) => {
    const source = expectPlainObject(value, path);
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(source)) {
      defineDataProperty(
        output,
        key,
        serializeNested(valueSerializer, source[key] as A, appendPropertyPath(path, key)),
      );
    }
    return output;
  });
}

function objectJsonSerializer<A extends object>(
  properties: readonly JsonObjectProperty<A>[],
  options: JsonObjectSerializerOptions<A> = {},
): JsonSerializer<A> {
  const erased = properties.map((property): ErasedJsonObjectProperty => ({
    property: property.property,
    wireName: property.wireName,
    serializer: property.serializer as JsonSerializer<unknown>,
    optional: property.optional === true,
  }));
  validateObjectSchema(erased);

  const declaredProperties = new Set(erased.map((property) => property.property));
  const declaredWireNames = new Set(erased.map((property) => property.wireName));
  const additionalProperties = options.additionalProperties as JsonSerializer<unknown> | undefined;

  return JsonSerializer.of((value, path) => {
    const source = expectObject(value, path);
    const output: Record<string, unknown> = Object.create(null);

    for (const property of erased) {
      const propertyPath = appendPropertyPath(path, property.property);
      const present = Object.prototype.hasOwnProperty.call(source, property.property);
      const propertyValue = present ? source[property.property] : undefined;
      if (!present || propertyValue === undefined) {
        if (property.optional) continue;
        throw new JsonSerializationError(propertyPath, "Required property is missing.");
      }
      defineDataProperty(
        output,
        property.wireName,
        serializeNested(property.serializer, propertyValue, propertyPath),
      );
    }

    if (additionalProperties) {
      for (const key of Object.keys(source)) {
        if (declaredProperties.has(key)) continue;
        if (declaredWireNames.has(key)) {
          throw new JsonSerializationError(
            appendPropertyPath(path, key),
            `Additional property conflicts with encoded property name ${JSON.stringify(key)}.`,
          );
        }
        const propertyValue = source[key];
        if (propertyValue === undefined) continue;
        defineDataProperty(
          output,
          key,
          serializeNested(additionalProperties, propertyValue, appendPropertyPath(path, key)),
        );
      }
    }

    return output;
  });
}

function exactObjectJsonSerializer<A extends object>(
  serializer: JsonSerializer<A>,
  properties: readonly string[],
): JsonSerializer<A> {
  const allowed = new Set(properties);
  if (allowed.size !== properties.length) {
    throw new TypeError("Exact JSON object properties must be unique.");
  }

  return JsonSerializer.of((value, path) => {
    const source = expectObject(value, path);
    for (const property of Object.keys(source)) {
      if (!allowed.has(property)) {
        throw new JsonSerializationError(
          appendPropertyPath(path, property),
          "Unexpected property.",
        );
      }
    }
    return serializeNested(serializer, value, path);
  });
}

function unionJsonSerializer<A>(variants: readonly JsonSerializer<unknown>[]): JsonSerializer<A> {
  if (variants.length === 0) {
    throw new TypeError("A JSON union serializer requires at least one variant.");
  }

  return JsonSerializer.of((value, path) => {
    let matched = false;
    let result: unknown;
    const errors: JsonSerializationError[] = [];

    for (const variant of variants) {
      let candidate: unknown;
      try {
        candidate = serializeNested(variant, value, path);
      } catch (error) {
        if (error instanceof JsonSerializationError) {
          errors.push(error);
          continue;
        }
        throw error;
      }

      if (!matched) {
        matched = true;
        result = candidate;
        continue;
      }
      let equivalent: boolean;
      try {
        equivalent = jsonWireValuesEqual(result, candidate);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new JsonSerializationError(path, `Failed to compare union variants: ${message}`, {
          cause: error,
        });
      }
      if (!equivalent) {
        throw new JsonSerializationError(
          path,
          "Value matches multiple union variants with different JSON wire representations.",
        );
      }
    }

    if (matched) return result;
    throw new JsonSerializationError(path, "Value did not match any union variant.", {
      cause: new AggregateError(errors),
    });
  });
}

function nullableJsonSerializer<A>(inner: JsonSerializer<A>): JsonSerializer<A | null> {
  return JsonSerializer.of((value, path) =>
    value === null ? null : serializeNested(inner, value, path),
  );
}

function discriminatedJsonSerializer<A>(
  discriminator: string,
  variants: Readonly<Record<string, JsonSerializer<A>>>,
  options: JsonDiscriminatedSerializerOptions<A> = {},
): JsonSerializer<A> {
  return JsonSerializer.of((value, path) => {
    const source = expectObject(value, path);
    const tag = Object.prototype.hasOwnProperty.call(source, discriminator)
      ? source[discriminator]
      : undefined;
    const key = typeof tag === "string" || typeof tag === "number" ? String(tag) : undefined;
    const namedVariant =
      key !== undefined && Object.prototype.hasOwnProperty.call(variants, key)
        ? variants[key]
        : undefined;
    const variant = namedVariant ?? (key === undefined ? undefined : options.defaultVariant);
    if (!variant) {
      throw new JsonSerializationError(
        appendPropertyPath(path, discriminator),
        `Unknown discriminator value: ${JSON.stringify(tag)}.`,
      );
    }
    return serializeNested(variant, value, path);
  });
}

function lazyJsonSerializer<A>(resolve: () => JsonSerializer<A>): JsonSerializer<A> {
  let serializer: JsonSerializer<A> | undefined;
  return JsonSerializer.of((value, path) => {
    serializer ??= resolve();
    return serializeNested(serializer, value, path);
  });
}

function scalarJsonSerializer<A>(transform: (value: A) => unknown): JsonSerializer<A> {
  return JsonSerializer.of((value, path) => {
    try {
      return transform(value);
    } catch (error) {
      if (error instanceof JsonSerializationError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new JsonSerializationError(path, message, { cause: error });
    }
  });
}

function transformInputJsonSerializer<A, B>(
  serializer: JsonSerializer<B>,
  transform: (value: A) => B,
): JsonSerializer<A> {
  return JsonSerializer.of((value, path) => {
    let transformed: B;
    try {
      transformed = transform(value);
    } catch (error) {
      if (error instanceof JsonSerializationError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new JsonSerializationError(path, message, { cause: error });
    }
    return serializeNested(serializer, transformed, path);
  });
}

function validatedJsonSerializer<A, Wire>(
  serializer: JsonSerializer<A>,
  ...validators: readonly Validator<Wire>[]
): JsonSerializer<A> {
  return JsonSerializer.of((value, path) => {
    const wireValue = serializer.serialize(value, path);
    const messages = validators.flatMap((validator) =>
      validator.validate(wireValue as Wire).map((issue) => issue.message),
    );
    if (messages.length > 0) {
      throw new JsonSerializationError(path, messages.join(" "));
    }
    return wireValue;
  });
}

function encodedNumberStringJsonSerializer(options?: NumericWireEncoding): JsonSerializer<number> {
  return scalarJsonSerializer((value) => ScalarEncodings.encodeNumberString(value, options));
}

function encodedBigIntStringJsonSerializer(options?: NumericWireEncoding): JsonSerializer<bigint> {
  return scalarJsonSerializer((value) => ScalarEncodings.encodeBigIntString(value, options));
}

const encodedBooleanStringJsonSerializer: JsonSerializer<boolean> = scalarJsonSerializer(
  ScalarEncodings.encodeBooleanString,
);
const rfc3339DateTimeJsonSerializer: JsonSerializer<string> = scalarJsonSerializer(
  ScalarEncodings.encodeRfc3339DateTime,
);
const rfc7231DateTimeJsonSerializer: JsonSerializer<string> = scalarJsonSerializer(
  ScalarEncodings.encodeRfc7231DateTime,
);
const isoDurationJsonSerializer: JsonSerializer<string> = scalarJsonSerializer(
  ScalarEncodings.encodeIsoDuration,
);
const base64BytesJsonSerializer: JsonSerializer<Uint8Array> = scalarJsonSerializer(
  ScalarEncodings.encodeBase64,
);
const base64UrlBytesJsonSerializer: JsonSerializer<Uint8Array> = scalarJsonSerializer(
  ScalarEncodings.encodeBase64Url,
);

function unixTimestampJsonSerializer(options?: NumericWireEncoding): JsonSerializer<string> {
  return scalarJsonSerializer((value) => ScalarEncodings.encodeUnixTimestamp(value, options));
}

function numericDurationJsonSerializer(
  unit: DurationNumericUnit,
  options?: NumericWireEncoding,
): JsonSerializer<string> {
  return scalarJsonSerializer((value) =>
    ScalarEncodings.encodeNumericDuration(value, unit, options),
  );
}

function serializeNested<A>(serializer: JsonSerializer<A>, value: A, path: string): unknown {
  try {
    return serializer.serialize(value, path);
  } catch (error) {
    if (error instanceof JsonSerializationError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new JsonSerializationError(path, message, { cause: error });
  }
}

function expectPlainObject(value: unknown, path: string): Record<string, unknown> {
  const object = expectObject(value, path);
  const prototype = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new JsonSerializationError(path, "Expected a plain object.");
  }
  return object;
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JsonSerializationError(path, "Expected an object.");
  }
  return value as Record<string, unknown>;
}

function validateObjectSchema(properties: readonly ErasedJsonObjectProperty[]): void {
  const sourceNames = new Set<string>();
  const wireNames = new Set<string>();
  for (const property of properties) {
    if (sourceNames.has(property.property)) {
      throw new TypeError(`Duplicate JSON source property ${JSON.stringify(property.property)}.`);
    }
    if (wireNames.has(property.wireName)) {
      throw new TypeError(`Duplicate JSON wire property ${JSON.stringify(property.wireName)}.`);
    }
    sourceNames.add(property.property);
    wireNames.add(property.wireName);
  }
}

function jsonWireValuesEqual(
  left: unknown,
  right: unknown,
  seen: WeakMap<object, WeakSet<object>> = new WeakMap(),
): boolean {
  return normalizedJsonWireValuesEqual(
    normalizeJsonWireValue(left, ""),
    normalizeJsonWireValue(right, ""),
    seen,
  );
}

const omittedJsonWireValue = Symbol("omittedJsonWireValue");

function normalizedJsonWireValuesEqual(
  left: unknown | typeof omittedJsonWireValue,
  right: unknown | typeof omittedJsonWireValue,
  seen: WeakMap<object, WeakSet<object>>,
): boolean {
  if (Object.is(left, right)) return true;
  if (left === omittedJsonWireValue || right === omittedJsonWireValue) return false;
  const leftIsNumber = typeof left === "number" || typeof left === "bigint";
  const rightIsNumber = typeof right === "number" || typeof right === "bigint";
  if (leftIsNumber || rightIsNumber) {
    return leftIsNumber && rightIsNumber && String(left) === String(right);
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  }

  let paired = seen.get(left);
  if (paired?.has(right)) return true;
  if (!paired) {
    paired = new WeakSet();
    seen.set(left, paired);
  }
  paired.add(right);

  if (Array.isArray(left) && Array.isArray(right)) {
    for (let index = 0; index < left.length; index += 1) {
      if (
        !normalizedJsonWireValuesEqual(
          normalizeJsonArrayValue(left[index], String(index)),
          normalizeJsonArrayValue(right[index], String(index)),
          seen,
        )
      ) {
        return false;
      }
    }
    return true;
  }

  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  const leftProperties = normalizedJsonObjectProperties(leftObject);
  const rightProperties = normalizedJsonObjectProperties(rightObject);
  if (leftProperties.size !== rightProperties.size) return false;
  for (const [key, leftValue] of leftProperties) {
    if (!rightProperties.has(key)) return false;
    if (!normalizedJsonWireValuesEqual(leftValue, rightProperties.get(key), seen)) {
      return false;
    }
  }
  return true;
}

function normalizeJsonWireValue(
  value: unknown,
  key: string,
): unknown | typeof omittedJsonWireValue {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return omittedJsonWireValue;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (value instanceof Uint8Array) return ScalarEncodings.encodeBase64(value);
  if (value instanceof Number || value instanceof String || value instanceof Boolean) {
    return normalizeJsonWireValue(value.valueOf(), key);
  }
  if (typeof value === "object" && value !== null) {
    const toJSON = (value as { toJSON?: (key: string) => unknown }).toJSON;
    if (typeof toJSON === "function") {
      const replacement = toJSON.call(value, key);
      if (replacement !== value) return normalizeJsonWireValue(replacement, key);
    }
  }
  return value;
}

function normalizeJsonArrayValue(
  value: unknown,
  key: string,
): unknown | typeof omittedJsonWireValue {
  const normalized = normalizeJsonWireValue(value, key);
  return normalized === omittedJsonWireValue ? null : normalized;
}

function normalizedJsonObjectProperties(
  value: Record<string, unknown>,
): Map<string, unknown | typeof omittedJsonWireValue> {
  const properties = new Map<string, unknown | typeof omittedJsonWireValue>();
  for (const key of Object.keys(value)) {
    const normalized = normalizeJsonWireValue(value[key], key);
    if (normalized !== omittedJsonWireValue) properties.set(key, normalized);
  }
  return properties;
}

function appendPropertyPath(path: string, property: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property)
    ? `${path}.${property}`
    : `${path}[${JSON.stringify(property)}]`;
}

function defineDataProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

export const JsonSerializers = {
  identity: identityJsonSerializer,
  literal: literalJsonSerializer,
  array: arrayJsonSerializer,
  tuple: tupleJsonSerializer,
  record: recordJsonSerializer,
  object: objectJsonSerializer,
  exactObject: exactObjectJsonSerializer,
  union: unionJsonSerializer,
  nullable: nullableJsonSerializer,
  discriminated: discriminatedJsonSerializer,
  lazy: lazyJsonSerializer,
  validate: validatedJsonSerializer,
  transformInput: transformInputJsonSerializer,
  encodedNumberString: encodedNumberStringJsonSerializer,
  encodedBigIntString: encodedBigIntStringJsonSerializer,
  encodedBooleanString: encodedBooleanStringJsonSerializer,
  rfc3339DateTime: rfc3339DateTimeJsonSerializer,
  rfc7231DateTime: rfc7231DateTimeJsonSerializer,
  unixTimestamp: unixTimestampJsonSerializer,
  isoDuration: isoDurationJsonSerializer,
  numericDuration: numericDurationJsonSerializer,
  base64Bytes: base64BytesJsonSerializer,
  base64UrlBytes: base64UrlBytesJsonSerializer,
} as const;
