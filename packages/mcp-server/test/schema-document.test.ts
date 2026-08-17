import { describe, expect, test } from "bun:test";
import { createSchemaDocument, type SchemaDocument } from "../src/index.js";

describe("schema documents", () => {
  test("hydrates and caches only the definitions reachable from a named schema", async () => {
    const node = {
      type: "object",
      properties: {
        label: { type: "string" },
        child: { anyOf: [{ type: "null" }, { $ref: "#/$defs/Node" }] },
      },
      required: ["label"],
      additionalProperties: false,
    } as const;
    const schemas = createSchemaDocument({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      schemas: {
        ReadNode: { $ref: "#/$defs/Node" },
        Label: { type: "string" },
        Escaped: { $ref: "#/$defs/Part~1One" },
      },
      $defs: {
        Node: node,
        "Part/One": { type: "string" },
        Unused: { type: "string", pattern: "[" },
      },
    });

    const readNode = schemas.get<{ label: string; child?: unknown }>("ReadNode");
    expect(schemas.get("ReadNode")).toBe(readNode);
    expect(Object.keys(readNode.jsonSchema.$defs as object)).toEqual(["Node"]);
    expect(schemas.get("Label").jsonSchema).not.toHaveProperty("$defs");
    expect(Object.keys(schemas.get("Escaped").jsonSchema.$defs as object)).toEqual(["Part/One"]);
    await expect(readNode.input["~standard"].validate({ label: "root" })).resolves.toEqual({
      value: { label: "root" },
    });
  });

  test("hydrates shared codec definitions for semantic values", async () => {
    const schemas = createSchemaDocument({
      schemas: { Count: { type: "integer" } },
      codecs: { Count: { kind: "ref", name: "Count" } },
      codecDefinitions: {
        Count: { kind: "bigint-number" },
        Unused: { kind: "bigint-string" },
      },
    });
    const count = schemas.get<number, bigint>("Count");

    await expect(count.input["~standard"].validate(5)).resolves.toEqual({ value: 5n });
    await expect(count.encode(6n)).resolves.toEqual({ ok: true, value: 6 });
  });

  test("distinguishes declared schemas from inherited properties", () => {
    const schemas = createSchemaDocument({ schemas: { Input: true } });
    expect(() => (schemas as SchemaDocument).get("Missing")).toThrow(
      'Schema "Missing" is not defined.',
    );
    expect(() => (schemas as SchemaDocument).get("toString")).toThrow(
      'Schema "toString" is not defined.',
    );

    const prototypeSchema = createSchemaDocument({ schemas: { ["__proto__"]: true } });
    expect(prototypeSchema.get("__proto__").jsonSchema).toMatchObject({ allOf: [true] });
  });
});
