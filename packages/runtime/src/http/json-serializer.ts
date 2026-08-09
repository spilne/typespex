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
  const erased = properties.map(
    (property): ErasedJsonObjectProperty => ({
      property: property.property,
      wireName: property.wireName,
      serializer: property.serializer as JsonSerializer<unknown>,
      optional: property.optional === true,
    }),
  );
  validateObjectSchema(erased);

  const declaredProperties = new Set(erased.map((property) => property.property));
  const declaredWireNames = new Set(erased.map((property) => property.wireName));
  const additionalProperties = options.additionalProperties as JsonSerializer<unknown> | undefined;

  return JsonSerializer.of((value, path) => {
    const source = expectPlainObject(value, path);
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

function nullableJsonSerializer<A>(inner: JsonSerializer<A>): JsonSerializer<A | null> {
  return JsonSerializer.of((value, path) =>
    value === null ? null : serializeNested(inner, value, path),
  );
}

function lazyJsonSerializer<A>(resolve: () => JsonSerializer<A>): JsonSerializer<A> {
  let serializer: JsonSerializer<A> | undefined;
  return JsonSerializer.of((value, path) => {
    serializer ??= resolve();
    return serializeNested(serializer, value, path);
  });
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JsonSerializationError(path, "Expected an object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new JsonSerializationError(path, "Expected a plain object.");
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
  array: arrayJsonSerializer,
  tuple: tupleJsonSerializer,
  record: recordJsonSerializer,
  object: objectJsonSerializer,
  nullable: nullableJsonSerializer,
  lazy: lazyJsonSerializer,
} as const;
