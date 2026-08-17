import type { ValueCodecSpec } from "@typespex/codec";
import { createSchema, type Schema } from "./schema.js";

type JsonSchema = boolean | Readonly<Record<string, unknown>>;
type SchemaNames<Schemas> = Extract<keyof Schemas, string>;

/** Named schemas and shared definitions for one MCP service. */
export interface SchemaDocumentDefinition<
  Schemas extends Readonly<Record<string, JsonSchema>> = Readonly<Record<string, JsonSchema>>,
> {
  /** JSON Schema dialect applied to named schemas that do not declare their own. */
  readonly $schema?: string;
  /** Schema roots addressed by `SchemaDocument.get`. */
  readonly schemas: Schemas;
  /** Shared JSON Schema definitions referenced by named roots. */
  readonly $defs?: Readonly<Record<string, JsonSchema>>;
  /** Semantic codecs keyed by named schema. Omit identity contracts. */
  readonly codecs?: Partial<Readonly<Record<SchemaNames<Schemas>, ValueCodecSpec>>>;
  /** Shared definitions referenced by semantic codecs. */
  readonly codecDefinitions?: Readonly<Record<string, ValueCodecSpec>>;
}

/** Lazily materializes named schemas from a shared service document. */
export interface SchemaDocument<Names extends string = string> {
  get<Wire = unknown, Semantic = Wire>(name: Names): Schema<Wire, Semantic>;
}

/** Creates a lazily hydrated collection of named service schemas. */
export function createSchemaDocument<const Schemas extends Readonly<Record<string, JsonSchema>>>(
  definition: SchemaDocumentDefinition<Schemas>,
): SchemaDocument<SchemaNames<Schemas>> {
  const cache = new Map<string, Schema<any, any>>();

  return {
    get<Wire = unknown, Semantic = Wire>(name: SchemaNames<Schemas>): Schema<Wire, Semantic> {
      const existing = cache.get(name);
      if (existing) return existing as Schema<Wire, Semantic>;
      if (!Object.hasOwn(definition.schemas, name)) {
        throw new TypeError(`Schema ${JSON.stringify(name)} is not defined.`);
      }

      const codec = ownValue(definition.codecs, name);
      const schema = createSchema<Wire, Semantic>({
        schema: hydrateJsonSchema(definition.schemas[name]!, definition.$schema, definition.$defs),
        ...(codec
          ? {
              codec: {
                root: codec,
                ...withCodecDefinitions(codec, definition.codecDefinitions),
              },
            }
          : {}),
      });
      cache.set(name, schema);
      return schema;
    },
  };
}

const DEFAULT_JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

function hydrateJsonSchema(
  root: JsonSchema,
  dialect: string | undefined,
  sharedDefinitions: Readonly<Record<string, JsonSchema>> | undefined,
): Readonly<Record<string, unknown>> {
  const rootDefinitions = isSchemaRecord(root) ? schemaDefinitions(root.$defs) : undefined;
  const definitions = mergeDefinitions(sharedDefinitions, rootDefinitions);
  const reachableDefinitions = selectSchemaDefinitions(root, definitions);
  const rootSchema =
    typeof root === "boolean"
      ? { allOf: [root] }
      : Object.fromEntries(
          Object.entries(root).filter(([name]) => name !== "$schema" && name !== "$defs"),
        );
  const rootDialect =
    isSchemaRecord(root) && typeof root.$schema === "string" ? root.$schema : dialect;

  return {
    $schema: rootDialect ?? DEFAULT_JSON_SCHEMA_DIALECT,
    ...rootSchema,
    ...(Object.keys(reachableDefinitions).length > 0 ? { $defs: reachableDefinitions } : {}),
  };
}

function selectSchemaDefinitions(
  root: JsonSchema,
  definitions: Readonly<Record<string, JsonSchema>>,
): Readonly<Record<string, JsonSchema>> {
  const selected = Object.create(null) as Record<string, JsonSchema>;
  const pending = localSchemaReferences(root);
  const visited = new Set<string>();

  while (pending.length > 0) {
    const name = pending.pop()!;
    if (visited.has(name)) continue;
    visited.add(name);
    if (!Object.hasOwn(definitions, name)) continue;
    const schema = definitions[name]!;
    defineDataProperty(selected, name, schema);
    pending.push(...localSchemaReferences(schema));
  }

  return selected;
}

function localSchemaReferences(value: unknown): string[] {
  const references: string[] = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (!isSchemaRecord(current)) return;
    for (const [name, item] of Object.entries(current)) {
      if ((name === "$ref" || name === "$dynamicRef") && typeof item === "string") {
        const definition = localDefinitionName(item);
        if (definition !== undefined) references.push(definition);
      } else if (name !== "$defs") {
        visit(item);
      }
    }
  };
  visit(value);
  return references;
}

function localDefinitionName(reference: string): string | undefined {
  if (!reference.startsWith("#/$defs/")) return undefined;
  const token = reference.slice("#/$defs/".length).split("/", 1)[0]!;
  try {
    return decodeURIComponent(token).replaceAll("~1", "/").replaceAll("~0", "~");
  } catch {
    return token.replaceAll("~1", "/").replaceAll("~0", "~");
  }
}

function withCodecDefinitions(
  root: ValueCodecSpec,
  definitions: Readonly<Record<string, ValueCodecSpec>> | undefined,
): { readonly definitions?: Readonly<Record<string, ValueCodecSpec>> } {
  if (!definitions) return {};
  const selected = selectCodecDefinitions(root, definitions);
  return Object.keys(selected).length > 0 ? { definitions: selected } : {};
}

function selectCodecDefinitions(
  root: ValueCodecSpec,
  definitions: Readonly<Record<string, ValueCodecSpec>>,
): Readonly<Record<string, ValueCodecSpec>> {
  const selected = Object.create(null) as Record<string, ValueCodecSpec>;
  const pending = codecReferences(root);
  const visited = new Set<string>();

  while (pending.length > 0) {
    const name = pending.pop()!;
    if (visited.has(name)) continue;
    visited.add(name);
    if (!Object.hasOwn(definitions, name)) continue;
    const codec = definitions[name]!;
    defineDataProperty(selected, name, codec);
    pending.push(...codecReferences(codec));
  }

  return selected;
}

function codecReferences(value: unknown): string[] {
  const references: string[] = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (!isSchemaRecord(current)) return;
    if (current.kind === "ref" && typeof current.name === "string") {
      references.push(current.name);
      return;
    }
    for (const item of Object.values(current)) visit(item);
  };
  visit(value);
  return references;
}

function mergeDefinitions<T>(
  shared: Readonly<Record<string, T>> | undefined,
  local: Readonly<Record<string, T>> | undefined,
): Readonly<Record<string, T>> {
  const merged = Object.create(null) as Record<string, T>;
  for (const definitions of [shared, local]) {
    if (!definitions) continue;
    for (const [name, value] of Object.entries(definitions)) {
      defineDataProperty(merged, name, value);
    }
  }
  return merged;
}

function schemaDefinitions(value: unknown): Readonly<Record<string, JsonSchema>> | undefined {
  if (!isSchemaRecord(value)) return undefined;
  const definitions = Object.create(null) as Record<string, JsonSchema>;
  for (const [name, schema] of Object.entries(value)) {
    if (typeof schema === "boolean" || isSchemaRecord(schema)) {
      defineDataProperty(definitions, name, schema);
    }
  }
  return definitions;
}

function ownValue<T>(
  values: Partial<Readonly<Record<string, T>>> | undefined,
  name: string,
): T | undefined {
  return values && Object.hasOwn(values, name) ? values[name] : undefined;
}

function isSchemaRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defineDataProperty<T>(target: Record<string, T>, name: string, value: T): void {
  Object.defineProperty(target, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
