import {
  fromJsonSchema,
  type JsonSchemaType,
  type StandardSchemaV1,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import {
  createValueCodec,
  jsonValuesEqual,
  type CodecIssue,
  type ValueCodecDocument,
} from "@typespex/codec";

import { reachableCodecSpecs } from "./codec-graph.js";

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
  const jsonWire = lazyJsonSchema<Wire>(schema);
  const validatesBranch = createBranchValidator(schema);
  const codec = definition.codec
    ? createValueCodec<Semantic>(definition.codec, { validateWire: validatesBranch })
    : undefined;
  const wire: StandardSchemaWithJSON<Wire, Wire> =
    codec && hasNumericConstraints(definition.codec!)
      ? {
          "~standard": {
            ...jsonWire["~standard"],
            async validate(value: unknown): Promise<StandardSchemaV1.Result<Wire>> {
              const validated = await jsonWire["~standard"].validate(value);
              if (validated.issues) return validated;
              // Some semantic bounds cannot be expressed for JSON strings. Run
              // the codec checks while preserving the original wire value.
              const decoded = await codec.validateWire(validated.value);
              return decoded.ok
                ? validated
                : { issues: decoded.issues.map(codecIssueToStandardIssue) };
            },
          },
        }
      : jsonWire;
  const projectWireValue = codec ? undefined : createWireProjector(schema, validatesBranch);
  const input: StandardSchemaWithJSON<Wire, Semantic> = {
    "~standard": {
      version: 1,
      vendor: "typespex",
      jsonSchema: jsonSchemaConverter(schema),
      async validate(value: unknown): Promise<StandardSchemaV1.Result<Semantic>> {
        const validated = await jsonWire["~standard"].validate(value);
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

function hasNumericConstraints(document: ValueCodecDocument): boolean {
  for (const spec of reachableCodecSpecs(document.root, document.definitions)) {
    if (spec.numericConstraints !== undefined) return true;
  }
  return false;
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
function createBranchValidator(rootSchema: Readonly<Record<string, unknown>>) {
  const validators = new Map<JsonSchema, StandardSchemaWithJSON<unknown, unknown>>();
  return async (schema: JsonSchema, value: unknown): Promise<boolean> => {
    let validator = validators.get(schema);
    if (!validator) {
      validator = lazyJsonSchema<unknown>(branchDocument(schema, rootSchema));
      validators.set(schema, validator);
    }
    const result = await validator["~standard"].validate(value);
    return result.issues === undefined;
  };
}

function createWireProjector(
  rootSchema: Readonly<Record<string, unknown>>,
  validatesBranch: (schema: JsonSchema, value: unknown) => Promise<boolean>,
): (value: unknown) => Promise<unknown> {
  return (value) =>
    projectJsonValue(
      value,
      rootSchema,
      rootSchema,
      {
        strictObjects: false,
        strict: { seen: new WeakMap(), active: new WeakMap() },
        loose: { seen: new WeakMap(), active: new WeakMap() },
      },
      0,
      validatesBranch,
    );
}

interface ProjectionContext {
  readonly strictObjects: boolean;
  readonly strict: {
    readonly seen: SeenProjections;
    readonly active: WeakMap<object, Set<JsonSchema>>;
  };
  readonly loose: {
    readonly seen: SeenProjections;
    readonly active: WeakMap<object, Set<JsonSchema>>;
  };
}

type JsonSchema = boolean | Readonly<Record<string, unknown>>;
type ProjectionResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: WireProjectionError };
type SeenProjections = WeakMap<object, Map<JsonSchema, Map<number, ProjectionResult>>>;
const MAX_WIRE_PROJECTION_DEPTH = 128;

class WireProjectionError extends Error {
  constructor(
    message: string,
    readonly reason?: "ambiguous" | "invalid-value" | "shape" | "projection",
  ) {
    super(message);
  }
}

async function projectJsonValue(
  value: unknown,
  schema: JsonSchema,
  rootSchema: Readonly<Record<string, unknown>>,
  context: ProjectionContext,
  depth: number,
  validatesBranch: (schema: JsonSchema, value: unknown) => Promise<boolean>,
): Promise<unknown> {
  if (depth > MAX_WIRE_PROJECTION_DEPTH)
    throw new WireProjectionError("Wire projection nesting limit exceeded.");
  if (value === null || typeof value !== "object")
    return projectUncheckedValue(value, schema, rootSchema, context, depth, validatesBranch);
  const { seen, active } = context.strictObjects ? context.strict : context.loose;
  const previous = seen.get(value)?.get(schema)?.get(depth);
  if (previous) {
    if (!previous.ok) throw previous.error;
    return previous.value;
  }
  const pending = active.get(value) ?? new Set<JsonSchema>();
  if (pending.has(schema))
    throw new WireProjectionError("Cyclic semantic values cannot be encoded as JSON.");
  pending.add(schema);
  active.set(value, pending);
  let result: ProjectionResult;
  try {
    result = {
      ok: true,
      value: await projectUncheckedValue(
        value,
        schema,
        rootSchema,
        context,
        depth,
        validatesBranch,
      ),
    };
  } catch (error) {
    if (!(error instanceof WireProjectionError)) throw error;
    result = { ok: false, error };
  } finally {
    pending.delete(schema);
  }
  // A failed recursive branch is reusable too; never publish a partial projection.
  const projections = seen.get(value) ?? new Map<JsonSchema, Map<number, ProjectionResult>>();
  const depths = projections.get(schema) ?? new Map<number, ProjectionResult>();
  depths.set(depth, result);
  projections.set(schema, depths);
  seen.set(value, projections);
  if (!result.ok) throw result.error;
  return result.value;
}

async function projectUncheckedValue(
  value: unknown,
  schema: JsonSchema,
  rootSchema: Readonly<Record<string, unknown>>,
  context: ProjectionContext,
  depth: number,
  validatesBranch: (schema: JsonSchema, value: unknown) => Promise<boolean>,
): Promise<unknown> {
  if (typeof schema === "boolean") return value;
  if (
    (Object.hasOwn(schema, "const") && !jsonValuesEqual(schema.const, value)) ||
    (Array.isArray(schema.enum) && !schema.enum.some((item) => jsonValuesEqual(item, value)))
  ) {
    throw new WireProjectionError("Value does not match the declared literal.", "shape");
  }
  let projected = value;
  if (typeof schema.$ref === "string") {
    const target = resolveLocalSchemaReference(rootSchema, schema.$ref);
    if (target !== undefined)
      projected = await projectJsonValue(
        projected,
        target,
        rootSchema,
        context,
        depth + 1,
        validatesBranch,
      );
  }
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) {
      if (isJsonSchema(part))
        projected = await projectJsonValue(
          projected,
          part,
          rootSchema,
          context,
          depth + 1,
          validatesBranch,
        );
    }
  }
  const alternatives = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (alternatives) {
    let matched = false;
    let projectionError: WireProjectionError | undefined;
    for (const strictObjects of context.strictObjects ? [true] : [true, false]) {
      let match: { value: unknown } | undefined;
      let fatal: WireProjectionError | undefined;
      let coveredFailure: WireProjectionError | undefined;
      for (const alternative of alternatives) {
        if (!isJsonSchema(alternative)) continue;
        let candidate: unknown;
        try {
          candidate = await projectJsonValue(
            projected,
            alternative,
            rootSchema,
            { ...context, strictObjects },
            depth + 1,
            validatesBranch,
          );
        } catch (error) {
          if (!(error instanceof WireProjectionError)) throw error;
          projectionError = error;
          if (error.reason === "ambiguous" || error.reason === "invalid-value") fatal = error;
          else if (
            error.reason !== "shape" &&
            error.reason !== "projection" &&
            strictObjects &&
            matchesSchemaContainer(projected, alternative, rootSchema)
          )
            coveredFailure = error;
          continue;
        }
        if (!(await validatesBranch(alternative, candidate))) {
          if (strictObjects && matchesSchemaContainer(projected, alternative, rootSchema))
            coveredFailure = new WireProjectionError(
              "A declared union field could not be projected.",
            );
          continue;
        }
        if (match && !jsonValuesEqual(match.value, candidate))
          fatal = new WireProjectionError(
            "Value matches multiple union branches with incompatible projections.",
            "ambiguous",
          );
        match = { value: candidate };
      }
      if (fatal) throw fatal;
      if (match) {
        projected = match.value;
        matched = true;
        break;
      }
      if (coveredFailure) throw new WireProjectionError(coveredFailure.message, "invalid-value");
    }
    if (!matched)
      throw projectionError ?? new WireProjectionError("Value does not match any union branch.");
  }
  if (Array.isArray(projected)) {
    const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    const itemSchema = isJsonSchema(schema.items) ? schema.items : undefined;
    const output = new Array<unknown>(projected.length);
    for (let index = 0; index < projected.length; index++) {
      if (!Object.hasOwn(projected, index)) continue;
      const selected = isJsonSchema(prefixItems[index]) ? prefixItems[index] : itemSchema;
      output[index] =
        selected !== undefined
          ? await projectJsonValue(
              projected[index],
              selected,
              rootSchema,
              context,
              depth + 1,
              validatesBranch,
            )
          : projected[index];
    }
    return output;
  }
  if (!isPlainObject(projected)) return projected;
  const properties = isSchemaRecord(schema.properties) ? schema.properties : undefined;
  const additionalProperties = schema.additionalProperties;
  if (!properties && additionalProperties === undefined) return projected;
  if (
    context.strictObjects &&
    additionalProperties === false &&
    Object.keys(projected).some((name) => !properties || !Object.hasOwn(properties, name))
  ) {
    throw new WireProjectionError("Property is not declared by this union branch.", "projection");
  }
  if (
    Array.isArray(schema.required) &&
    schema.required.some(
      (name) =>
        typeof name === "string" &&
        (!Object.hasOwn(projected, name) || projected[name] === undefined),
    )
  ) {
    throw new WireProjectionError("A required union property is missing.", "shape");
  }
  const output: Record<string, unknown> = {};
  const errors: WireProjectionError[] = [];
  for (const name of Object.keys(projected)) {
    const propertySchema = properties && Object.hasOwn(properties, name) ? properties[name] : null;
    if (!isJsonSchema(propertySchema) && additionalProperties === false) continue;
    const item = projected[name];
    if (isJsonSchema(propertySchema) && item === undefined) continue;
    const selected = isJsonSchema(propertySchema)
      ? propertySchema
      : isJsonSchema(additionalProperties)
        ? additionalProperties
        : undefined;
    try {
      defineDataProperty(
        output,
        name,
        selected !== undefined
          ? await projectJsonValue(item, selected, rootSchema, context, depth + 1, validatesBranch)
          : item,
      );
    } catch (error) {
      if (!(error instanceof WireProjectionError)) throw error;
      errors.push(
        error.reason === "shape" &&
          selected !== undefined &&
          matchesSchemaContainer(item, selected, rootSchema)
          ? new WireProjectionError(error.message)
          : error,
      );
    }
  }
  if (errors.length)
    throw (
      errors.find((error) => error.reason === "shape") ??
      errors.find((error) => error.reason === "projection") ??
      errors[0]
    );
  return output;
}

function matchesSchemaContainer(
  value: unknown,
  schema: JsonSchema,
  root: Readonly<Record<string, unknown>>,
  seen = new Set<JsonSchema>(),
): boolean {
  if (typeof schema === "boolean" || seen.has(schema)) return false;
  seen.add(schema);
  if (schema.type === "object") return isPlainObject(value);
  if (schema.type === "array") return Array.isArray(value);
  if (typeof schema.$ref === "string") {
    const target = resolveLocalSchemaReference(root, schema.$ref);
    if (target !== undefined && matchesSchemaContainer(value, target, root, seen)) return true;
  }
  for (const parts of [schema.anyOf, schema.oneOf, schema.allOf]) {
    if (
      Array.isArray(parts) &&
      parts.some((part) => isJsonSchema(part) && matchesSchemaContainer(value, part, root, seen))
    )
      return true;
  }
  return false;
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
