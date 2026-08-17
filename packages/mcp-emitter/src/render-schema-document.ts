import {
  typescriptProperty,
  typescriptString,
  type JsonWirePlan,
} from "@typespex/compiler-core/unstable";
import { isSchemaRecord } from "./schema-utils.js";
import type { PlannedTool } from "./types.js";

type SchemaKind = "Input" | "Success" | "Error";

interface NamedSchema {
  readonly name: string;
  readonly plan: JsonWirePlan;
}

interface JsonDocument {
  readonly root: unknown;
  readonly dialect?: string;
  readonly definitions: Readonly<Record<string, unknown>>;
}

interface DefinitionEnvironment {
  readonly names: ReadonlyMap<string, string>;
}

export function renderSchemaDocument(tools: readonly PlannedTool[]): string {
  const schemas = tools.flatMap(namedToolSchemas);
  const jsonDocuments = schemas.map(({ plan }) => splitJsonDocument(plan.schema));
  const dialect = sharedDialect(jsonDocuments);
  const jsonDefinitions = new Map<string, unknown>();
  const jsonEnvironments = new Map<string, DefinitionEnvironment>();
  const usedJsonNames = new Set<string>();
  const namedSchemas = Object.fromEntries(
    schemas.map(({ name }, index) => {
      const document = jsonDocuments[index]!;
      const environment = definitionEnvironment(
        document.definitions,
        name,
        jsonEnvironments,
        jsonDefinitions,
        usedJsonNames,
        rewriteSchemaReferences,
      );
      const root = rewriteSchemaReferences(document.root, environment.names);
      return [
        name,
        document.dialect !== undefined && document.dialect !== dialect
          ? { $schema: document.dialect, ...(isSchemaRecord(root) ? root : { allOf: [root] }) }
          : root,
      ];
    }),
  );

  const codecDefinitions = new Map<string, unknown>();
  const codecEnvironments = new Map<string, DefinitionEnvironment>();
  const usedCodecNames = new Set<string>();
  const codecs = Object.fromEntries(
    schemas.flatMap(({ name, plan }) => {
      if (!plan.codec) return [];
      const definitions = plan.codec.definitions ?? {};
      const environment = definitionEnvironment(
        definitions,
        name,
        codecEnvironments,
        codecDefinitions,
        usedCodecNames,
        rewriteCodecReferences,
      );
      return [[name, rewriteCodecReferences(plan.codec.root, environment.names)]];
    }),
  );

  return `const schemaDocument = createSchemaDocument(${typescriptValue({
    ...(dialect ? { $schema: dialect } : {}),
    schemas: namedSchemas,
    ...(jsonDefinitions.size > 0 ? { $defs: Object.fromEntries(jsonDefinitions) } : {}),
    ...(Object.keys(codecs).length > 0 ? { codecs } : {}),
    ...(codecDefinitions.size > 0
      ? { codecDefinitions: Object.fromEntries(codecDefinitions) }
      : {}),
  })});`;
}

export function renderSchemaReference(
  name: string,
  wireType: string,
  semanticType: string,
): string {
  const typeArguments =
    wireType === semanticType ? `<${semanticType}>` : `<${wireType}, ${semanticType}>`;
  return `schemaDocument.get${typeArguments}(${typescriptString(name)})`;
}

function namedToolSchemas(tool: PlannedTool): NamedSchema[] {
  return [
    { name: schemaName(tool.symbolName, "Input"), plan: tool.plan.input },
    ...(tool.plan.success
      ? [{ name: schemaName(tool.symbolName, "Success"), plan: tool.plan.success }]
      : []),
    ...(tool.plan.errors
      ? [{ name: schemaName(tool.symbolName, "Error"), plan: tool.plan.errors }]
      : []),
  ];
}

function schemaName(symbolName: string, kind: SchemaKind): string {
  return `${symbolName}${kind}`;
}

function splitJsonDocument(schema: unknown): JsonDocument {
  if (!isSchemaRecord(schema)) return { root: schema, definitions: {} };
  const root = Object.fromEntries(
    Object.entries(schema).filter(([name]) => name !== "$schema" && name !== "$defs"),
  );
  return {
    root,
    ...(typeof schema.$schema === "string" ? { dialect: schema.$schema } : {}),
    definitions: isSchemaRecord(schema.$defs) ? schema.$defs : {},
  };
}

function sharedDialect(documents: readonly JsonDocument[]): string | undefined {
  const first = documents[0]?.dialect;
  return documents.every((document) => document.dialect === first) ? first : undefined;
}

function definitionEnvironment(
  definitions: Readonly<Record<string, unknown>>,
  context: string,
  environments: Map<string, DefinitionEnvironment>,
  output: Map<string, unknown>,
  usedNames: Set<string>,
  rewrite: (value: unknown, names: ReadonlyMap<string, string>) => unknown,
): DefinitionEnvironment {
  const key = typescriptString(definitions);
  const existing = environments.get(key);
  if (existing) return existing;

  const names = new Map<string, string>();
  for (const name of Object.keys(definitions)) {
    names.set(name, allocateDefinitionName(name, context, usedNames));
  }
  for (const [name, definition] of Object.entries(definitions)) {
    output.set(names.get(name)!, rewrite(definition, names));
  }
  const environment = { names };
  environments.set(key, environment);
  return environment;
}

function allocateDefinitionName(
  requested: string,
  context: string,
  usedNames: Set<string>,
): string {
  const base = requested || "Definition";
  let name = usedNames.has(base) ? `${base}For${context}` : base;
  let index = 2;
  while (usedNames.has(name)) name = `${base}For${context}${index++}`;
  usedNames.add(name);
  return name;
}

function rewriteSchemaReferences(value: unknown, names: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteSchemaReferences(item, names));
  if (!isSchemaRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [
      name,
      (name === "$ref" || name === "$dynamicRef") && typeof item === "string"
        ? rewriteLocalSchemaReference(item, names)
        : rewriteSchemaReferences(item, names),
    ]),
  );
}

function rewriteLocalSchemaReference(
  reference: string,
  names: ReadonlyMap<string, string>,
): string {
  const prefix = "#/$defs/";
  if (!reference.startsWith(prefix)) return reference;
  const remainder = reference.slice(prefix.length);
  const separator = remainder.indexOf("/");
  const token = separator === -1 ? remainder : remainder.slice(0, separator);
  const suffix = separator === -1 ? "" : remainder.slice(separator);
  const localName = decodeJsonPointerToken(token);
  const sharedName = names.get(localName);
  return sharedName === undefined
    ? reference
    : `${prefix}${encodeJsonPointerToken(sharedName)}${suffix}`;
}

function rewriteCodecReferences(value: unknown, names: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteCodecReferences(item, names));
  if (!isSchemaRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [
      name,
      value.kind === "ref" && name === "name" && typeof item === "string"
        ? (names.get(item) ?? item)
        : rewriteCodecReferences(item, names),
    ]),
  );
}

function decodeJsonPointerToken(token: string): string {
  try {
    return decodeURIComponent(token).replaceAll("~1", "/").replaceAll("~0", "~");
  } catch {
    return token.replaceAll("~1", "/").replaceAll("~0", "~");
  }
}

function encodeJsonPointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

function typescriptValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(typescriptValue).join(", ")}]`;
  if (!isSchemaRecord(value)) return typescriptString(value);
  return `{ ${Object.entries(value)
    .map(
      ([name, item]) =>
        `${name === "__proto__" ? `[${typescriptString(name)}]` : typescriptProperty(name)}: ${typescriptValue(item)}`,
    )
    .join(", ")} }`;
}
