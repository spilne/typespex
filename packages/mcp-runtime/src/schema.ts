import {
  fromJsonSchema,
  type JsonSchemaType,
  type StandardSchemaV1,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import {
  createValueCodec,
  type CodecIssue,
  type ValueCodecDocument,
} from "@typespex/runtime/codec";

export interface TypeSpecSchemaPlan {
  readonly schema: boolean | Readonly<Record<string, unknown>>;
  readonly codec: ValueCodecDocument;
}

export interface TypeSpecSchema<T = unknown> {
  /** Schema used for MCP input: validates wire JSON and decodes semantic values. */
  readonly input: StandardSchemaWithJSON<unknown, T>;
  /** Schema used for MCP output/error validation without applying input transforms. */
  readonly wire: StandardSchemaWithJSON<unknown, unknown>;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  encode(value: T): Promise<SchemaResult<unknown>>;
  validateWire(value: unknown): Promise<SchemaResult<unknown>>;
}

export type SchemaResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly StandardSchemaV1.Issue[] };

export function createTypeSpecSchema<T = unknown>(plan: TypeSpecSchemaPlan): TypeSpecSchema<T> {
  const schema = normalizeJsonSchema(plan.schema);
  const wire = fromJsonSchema(schema as JsonSchemaType);
  const codec = createValueCodec<T>(plan.codec);
  const input: StandardSchemaWithJSON<unknown, T> = {
    "~standard": {
      version: 1,
      vendor: "typespex",
      jsonSchema: wire["~standard"].jsonSchema,
      async validate(value: unknown): Promise<StandardSchemaV1.Result<T>> {
        const validated = await wire["~standard"].validate(value);
        if (validated.issues) return validated;
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
    async encode(value: T): Promise<SchemaResult<unknown>> {
      const encoded = await codec.encode(value);
      if (!encoded.ok) {
        return { ok: false, issues: encoded.issues.map(codecIssueToStandardIssue) };
      }
      return validate(wire, encoded.value);
    },
    async validateWire(value: unknown): Promise<SchemaResult<unknown>> {
      return validate(wire, value);
    },
  };
}

async function validate(
  schema: StandardSchemaWithJSON,
  value: unknown,
): Promise<SchemaResult<unknown>> {
  const result = await schema["~standard"].validate(value);
  return result.issues ? { ok: false, issues: result.issues } : { ok: true, value: result.value };
}

function normalizeJsonSchema(
  schema: boolean | Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return typeof schema === "boolean"
    ? { $schema: "https://json-schema.org/draft/2020-12/schema", allOf: [schema] }
    : schema;
}

function codecIssueToStandardIssue(issue: CodecIssue): StandardSchemaV1.Issue {
  return { message: issue.message, ...(issue.path.length > 0 ? { path: issue.path } : {}) };
}
