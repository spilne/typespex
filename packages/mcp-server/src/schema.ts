import {
  fromJsonSchema,
  type JsonSchemaType,
  type StandardSchemaV1,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { createValueCodec, type CodecIssue, type ValueCodecDocument } from "@typespex/codec";

/** Serializable schema and codec definition consumed by the MCP runtime. */
export interface SchemaDefinition {
  readonly schema: boolean | Readonly<Record<string, unknown>>;
  readonly codec?: ValueCodecDocument;
}

/** Runtime schema for validating wire values and converting semantic values. */
export interface Schema<Wire = unknown, Semantic = Wire> {
  /** Schema used for MCP input: validates wire JSON and decodes semantic values. */
  readonly input: StandardSchemaWithJSON<Wire, Semantic>;
  /** Schema used for MCP output/error validation without applying input transforms. */
  readonly wire: StandardSchemaWithJSON<Wire, Wire>;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  encode(value: Semantic, options?: SchemaEncodeOptions): Promise<SchemaResult<Wire>>;
  validateWire(value: unknown): Promise<SchemaResult<Wire>>;
}

export interface SchemaEncodeOptions {
  /** Skip JSON Schema validation when the MCP SDK will immediately validate the advertised output. */
  readonly validate?: boolean;
}

export type SchemaResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly StandardSchemaV1.Issue[] };

export function createSchema<Wire = unknown, Semantic = Wire>(
  definition: SchemaDefinition,
): Schema<Wire, Semantic> {
  const schema = normalizeJsonSchema(definition.schema);
  const wire = lazyJsonSchema<Wire>(schema);
  const codec = definition.codec ? createValueCodec<Semantic>(definition.codec) : undefined;
  const projectWireValue = codec ? undefined : createWireProjector(schema);
  const input: StandardSchemaWithJSON<Wire, Semantic> = {
    "~standard": {
      version: 1,
      vendor: "typespex",
      jsonSchema: jsonSchemaConverter(schema),
      async validate(value: unknown): Promise<StandardSchemaV1.Result<Semantic>> {
        const validated = await wire["~standard"].validate(value);
        if (validated.issues) return validated;
        if (!codec) return { value: validated.value as unknown as Semantic };
        const decoded = await codec.decode(validated.value);
        return decoded.ok
          ? { value: decoded.value }
          : { issues: decoded.issues.map(codecIssueToStandardIssue) };
      },
    },
  };

  return {
    input,
    wire,
    jsonSchema: schema,
    async encode(value: Semantic, options: SchemaEncodeOptions = {}): Promise<SchemaResult<Wire>> {
      if (!codec) {
        let projected: unknown;
        try {
          projected = await projectWireValue!(value);
        } catch (error) {
          if (error instanceof WireProjectionError) {
            return { ok: false, issues: [{ message: error.message }] };
          }
          throw error;
        }
        return options.validate === false
          ? { ok: true, value: projected as Wire }
          : validate(wire, projected);
      }
      const encoded = await codec.encode(value);
      if (!encoded.ok) {
        return { ok: false, issues: encoded.issues.map(codecIssueToStandardIssue) };
      }
      return options.validate === false
        ? { ok: true, value: encoded.value as Wire }
        : validate(wire, encoded.value);
    },
    async validateWire(value: unknown): Promise<SchemaResult<Wire>> {
      return validate(wire, value);
    },
  };
}

async function validate<Wire>(
  schema: StandardSchemaWithJSON<Wire, Wire>,
  value: unknown,
): Promise<SchemaResult<Wire>> {
  const result = await schema["~standard"].validate(value as Wire);
  return result.issues ? { ok: false, issues: result.issues } : { ok: true, value: result.value };
}

function lazyJsonSchema<Wire>(
  schema: Readonly<Record<string, unknown>>,
): StandardSchemaWithJSON<Wire, Wire> {
  let validator: StandardSchemaWithJSON<Wire, Wire> | undefined;
  return {
    "~standard": {
      version: 1,
      vendor: "typespex",
      jsonSchema: jsonSchemaConverter(schema),
      validate(
        value: unknown,
      ): StandardSchemaV1.Result<Wire> | Promise<StandardSchemaV1.Result<Wire>> {
        validator ??= fromJsonSchema<Wire>(schema as JsonSchemaType);
        return validator["~standard"].validate(value);
      },
    },
  };
}

function jsonSchemaConverter(schema: Readonly<Record<string, unknown>>) {
  const advertised = advertiseResolvedRootType(schema);
  return {
    input: () => advertised,
    output: () => advertised,
  };
}

/** The SDK's legacy output projection uses the root `type` without resolving local references. */
function advertiseResolvedRootType(
  schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (schema.type !== undefined) return schema;
  let target: JsonSchema = schema;
  const references = new Set<string>();
  while (typeof target !== "boolean" && typeof target.$ref === "string") {
    if (references.has(target.$ref)) return schema;
    references.add(target.$ref);
    const resolved = resolveLocalSchemaReference(schema, target.$ref);
    if (resolved === undefined) return schema;
    target = resolved;
  }
  return typeof target !== "boolean" && target.type !== undefined
    ? { ...schema, type: target.type }
    : schema;
}

function normalizeJsonSchema(
  schema: boolean | Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return typeof schema === "boolean"
    ? { $schema: "https://json-schema.org/draft/2020-12/schema", allOf: [schema] }
    : schema;
}

/**
 * Identity wire contracts still need serializer semantics: closed TypeSpec models must not expose
 * undeclared properties from wider handler values. Deriving that projection from JSON Schema keeps
 * generated identity contracts compact instead of emitting a second, mirrored codec document.
 */
function createWireProjector(
  rootSchema: Readonly<Record<string, unknown>>,
): (value: unknown) => Promise<unknown> {
  const branchValidators = new Map<unknown, StandardSchemaWithJSON<unknown, unknown>>();
  const validatesBranch = async (schema: JsonSchema, value: unknown): Promise<boolean> => {
    let validator = branchValidators.get(schema);
    if (!validator) {
      validator = lazyJsonSchema<unknown>(branchDocument(schema, rootSchema));
      branchValidators.set(schema, validator);
    }
    const result = await validator["~standard"].validate(value);
    return result.issues === undefined;
  };
  return (value) =>
    projectJsonValue(
      value,
      rootSchema,
      rootSchema,
      new WeakMap(),
      new WeakSet(),
      0,
      validatesBranch,
    );
}

type JsonSchema = boolean | Readonly<Record<string, unknown>>;
type SeenProjections = WeakMap<object, Map<JsonSchema, unknown>>;
const MAX_WIRE_PROJECTION_DEPTH = 128;

class WireProjectionError extends Error {}

async function projectJsonValue(
  value: unknown,
  schema: JsonSchema,
  rootSchema: Readonly<Record<string, unknown>>,
  seen: SeenProjections,
  active: WeakSet<object>,
  depth: number,
  validatesBranch: (schema: JsonSchema, value: unknown) => Promise<boolean>,
): Promise<unknown> {
  if (depth > MAX_WIRE_PROJECTION_DEPTH) {
    throw new WireProjectionError("Wire projection nesting limit exceeded.");
  }
  if (typeof schema === "boolean") return value;

  let projected = value;
  if (typeof schema.$ref === "string") {
    const target = resolveLocalSchemaReference(rootSchema, schema.$ref);
    if (target !== undefined) {
      projected = await projectJsonValue(
        projected,
        target,
        rootSchema,
        seen,
        active,
        depth + 1,
        validatesBranch,
      );
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) {
      if (isJsonSchema(part)) {
        projected = await projectJsonValue(
          projected,
          part,
          rootSchema,
          seen,
          active,
          depth + 1,
          validatesBranch,
        );
      }
    }
  }

  const alternatives = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (alternatives) {
    for (const alternative of alternatives) {
      if (!isJsonSchema(alternative)) continue;
      const candidate = await projectJsonValue(
        projected,
        alternative,
        rootSchema,
        seen,
        active,
        depth + 1,
        validatesBranch,
      );
      if (await validatesBranch(alternative, candidate)) {
        projected = candidate;
        break;
      }
    }
  }

  if (Array.isArray(projected)) {
    if (active.has(projected)) {
      throw new WireProjectionError("Cyclic semantic values cannot be encoded as JSON.");
    }
    const existing = seen.get(projected)?.get(schema);
    if (existing !== undefined) return existing;
    const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    const itemSchema = isJsonSchema(schema.items) ? schema.items : undefined;
    const output = new Array<unknown>(projected.length);
    const projections = seen.get(projected) ?? new Map<JsonSchema, unknown>();
    projections.set(schema, output);
    seen.set(projected, projections);
    active.add(projected);
    try {
      for (let index = 0; index < projected.length; index += 1) {
        if (!Object.hasOwn(projected, index)) continue;
        const item = projected[index];
        const selected = isJsonSchema(prefixItems[index]) ? prefixItems[index] : itemSchema;
        output[index] = selected
          ? await projectJsonValue(
              item,
              selected,
              rootSchema,
              seen,
              active,
              depth + 1,
              validatesBranch,
            )
          : item;
      }
      return output;
    } finally {
      active.delete(projected);
    }
  }

  if (!isPlainObject(projected)) return projected;
  const properties = isSchemaRecord(schema.properties) ? schema.properties : undefined;
  const additionalProperties = schema.additionalProperties;
  if (!properties && additionalProperties === undefined) return projected;
  if (active.has(projected)) {
    throw new WireProjectionError("Cyclic semantic values cannot be encoded as JSON.");
  }
  const existing = seen.get(projected)?.get(schema);
  if (existing !== undefined) return existing;

  const output: Record<string, unknown> = {};
  const projections = seen.get(projected) ?? new Map<JsonSchema, unknown>();
  projections.set(schema, output);
  seen.set(projected, projections);
  active.add(projected);
  try {
    for (const [name, item] of Object.entries(projected)) {
      const propertySchema =
        properties && Object.hasOwn(properties, name) ? properties[name] : null;
      if (isJsonSchema(propertySchema)) {
        if (item !== undefined) {
          defineDataProperty(
            output,
            name,
            await projectJsonValue(
              item,
              propertySchema,
              rootSchema,
              seen,
              active,
              depth + 1,
              validatesBranch,
            ),
          );
        }
        continue;
      }
      if (additionalProperties === false) continue;
      defineDataProperty(
        output,
        name,
        isJsonSchema(additionalProperties)
          ? await projectJsonValue(
              item,
              additionalProperties,
              rootSchema,
              seen,
              active,
              depth + 1,
              validatesBranch,
            )
          : item,
      );
    }
    return output;
  } finally {
    active.delete(projected);
  }
}

function branchDocument(
  schema: JsonSchema,
  rootSchema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (typeof schema === "boolean") return normalizeJsonSchema(schema);
  const rootDefinitions = isSchemaRecord(rootSchema.$defs) ? rootSchema.$defs : undefined;
  const branchDefinitions = isSchemaRecord(schema.$defs) ? schema.$defs : undefined;
  return {
    ...(typeof rootSchema.$schema === "string" ? { $schema: rootSchema.$schema } : {}),
    ...schema,
    ...(rootDefinitions || branchDefinitions
      ? { $defs: { ...rootDefinitions, ...branchDefinitions } }
      : {}),
  };
}

function resolveLocalSchemaReference(
  rootSchema: Readonly<Record<string, unknown>>,
  reference: string,
): JsonSchema | undefined {
  if (reference === "#") return rootSchema;
  if (!reference.startsWith("#/")) return undefined;
  let current: unknown = rootSchema;
  for (const token of reference
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (!isSchemaRecord(current) || !Object.hasOwn(current, token)) return undefined;
    current = current[token];
  }
  return isJsonSchema(current) ? current : undefined;
}

function isJsonSchema(value: unknown): value is JsonSchema {
  return typeof value === "boolean" || isSchemaRecord(value);
}

function isSchemaRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function defineDataProperty(target: Record<string, unknown>, name: string, value: unknown): void {
  Object.defineProperty(target, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function codecIssueToStandardIssue(issue: CodecIssue): StandardSchemaV1.Issue {
  return { message: issue.message, ...(issue.path.length > 0 ? { path: issue.path } : {}) };
}
