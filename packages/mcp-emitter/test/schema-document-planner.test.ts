import { describe, expect, test } from "bun:test";
import type { JsonWirePlan } from "@typespex/compiler-core/unstable";
import { planSchemaDocument } from "../src/schema-document-planner.js";
import { renderSchemaDocument } from "../src/render-schema-document.js";
import type { PlannedTool } from "../src/types.js";

function tool(
  name: string,
  schema: JsonWirePlan["schema"],
  codec?: JsonWirePlan["codec"],
): PlannedTool {
  return {
    name,
    symbolName: name,
    allowsVoid: true,
    requiresTaggedResult: false,
    plan: {
      version: 1,
      name,
      input: { version: 1, schema, codec, semanticType: "unknown", wireType: "unknown" },
    },
  };
}

describe("schema document planning", () => {
  test("resolves collisions and reuses matching definition environments before rendering", () => {
    const first = { $ref: "#/$defs/Value", $defs: { Value: { type: "string" } } };
    const second = { $ref: "#/$defs/Value", $defs: { Value: { type: "number" } } };
    const tools = [
      tool("First", first),
      tool("Second", second),
      tool("Third", structuredClone(first)),
    ];
    const before = structuredClone(tools);
    const document = planSchemaDocument(tools);
    expect(document).toEqual({
      schemas: {
        FirstInput: { $ref: "#/$defs/Value" },
        SecondInput: { $ref: "#/$defs/ValueForSecondInput" },
        ThirdInput: { $ref: "#/$defs/Value" },
      },
      $defs: { Value: { type: "string" }, ValueForSecondInput: { type: "number" } },
    });
    expect(tools).toEqual(before);
    expect(planSchemaDocument(tools)).toEqual(document);
  });

  test("rewrites recursive and escaped local references without changing external references", () => {
    const schema = (type: string) => ({
      $ref: "#/$defs/A~1B~0C",
      $defs: {
        ["A/B~C"]: {
          type,
          properties: {
            next: { $dynamicRef: "#/$defs/A~1B~0C/properties/value" },
            external: { $ref: "https://example.test/schema#/$defs/A~1B~0C" },
          },
        },
      },
    });
    const document = planSchemaDocument([
      tool("First", schema("object")),
      tool("Second", schema("array")),
    ]);
    expect(document.schemas.SecondInput).toEqual({ $ref: "#/$defs/A~1B~0CForSecondInput" });
    expect(document.$defs?.["A/B~CForSecondInput"]).toMatchObject({
      properties: {
        next: { $dynamicRef: "#/$defs/A~1B~0CForSecondInput/properties/value" },
        external: { $ref: "https://example.test/schema#/$defs/A~1B~0C" },
      },
    });
  });

  test("does not rewrite reference-shaped default and annotation data", () => {
    const value = { $ref: "#/$defs/Value", kind: "ref", name: "Value" };
    const schema = (type: string) => ({
      $ref: "#/$defs/Value",
      $defs: { Value: { type } },
      default: value,
      const: value,
      enum: [value],
      examples: [value],
      "x-metadata": value,
    });
    const codec = (type: "string" | "number") => ({
      root: { kind: "ref", name: "Value" } as const,
      definitions: {
        Value: {
          kind: "object" as const,
          properties: {
            payload: {
              wireName: "payload",
              codec: { kind: "primitive" as const, type },
              defaultValue: value,
              hasDefault: true,
            },
          },
        },
      },
    });
    const document = planSchemaDocument([
      tool("First", schema("string"), codec("string")),
      tool("Second", schema("number"), codec("number")),
    ]);
    expect(document.schemas.SecondInput).toEqual({
      $ref: "#/$defs/ValueForSecondInput",
      default: value,
      const: value,
      enum: [value],
      examples: [value],
      "x-metadata": value,
    });
    expect(document.codecDefinitions?.ValueForSecondInput).toMatchObject({
      properties: { payload: { defaultValue: value } },
    });
  });

  test("plans codec references separately from schema names", () => {
    const document = planSchemaDocument([
      tool("First", true, {
        root: { kind: "ref", name: "Value" },
        definitions: { Value: { kind: "bigint-string" } },
      }),
      tool("Second", false, {
        root: { kind: "ref", name: "Value" },
        definitions: { Value: { kind: "bytes" } },
      }),
    ]);
    expect(document.schemas).toEqual({ FirstInput: true, SecondInput: false });
    expect(document.codecs).toEqual({
      FirstInput: { kind: "ref", name: "Value" },
      SecondInput: { kind: "ref", name: "ValueForSecondInput" },
    });
    expect(document.codecDefinitions).toEqual({
      Value: { kind: "bigint-string" },
      ValueForSecondInput: { kind: "bytes" },
    });
  });

  test("relocates references through schema and codec collection children", () => {
    const schema = (name: string) => ({
      items: { $ref: `#/$defs/${name}` },
      anyOf: [{ $ref: `#/$defs/${name}` }],
      prefixItems: [{ $ref: `#/$defs/${name}` }],
      additionalProperties: { $ref: `#/$defs/${name}` },
    });
    const codec = (name: string): NonNullable<JsonWirePlan["codec"]>["root"] => ({
      kind: "object",
      properties: {
        array: { wireName: "array", codec: { kind: "array", item: { kind: "ref", name } } },
        tuple: { wireName: "tuple", codec: { kind: "tuple", items: [{ kind: "ref", name }] } },
        union: { wireName: "union", codec: { kind: "union", variants: [{ kind: "ref", name }] } },
      },
      additionalProperties: { kind: "ref", name },
    });
    const document = planSchemaDocument([
      tool(
        "First",
        { ...schema("Value"), $defs: { Value: { type: "string" } } },
        {
          root: codec("Value"),
          definitions: { Value: { kind: "bytes" } },
        },
      ),
      tool(
        "Second",
        { ...schema("Value"), $defs: { Value: { type: "number" } } },
        {
          root: codec("Value"),
          definitions: { Value: { kind: "bigint-string" } },
        },
      ),
    ]);
    expect(document.schemas.SecondInput).toEqual(schema("ValueForSecondInput"));
    expect(document.codecs?.SecondInput).toEqual(codec("ValueForSecondInput"));
  });

  test("retains mixed dialects locally and hoists a common dialect", () => {
    const first = tool("First", { $schema: "dialect-a", type: "string" });
    const second = tool("Second", { $schema: "dialect-b", type: "number" });
    expect(planSchemaDocument([first, second])).toEqual({
      schemas: {
        FirstInput: { $schema: "dialect-a", type: "string" },
        SecondInput: { $schema: "dialect-b", type: "number" },
      },
    });
    expect(planSchemaDocument([first])).toEqual({
      $schema: "dialect-a",
      schemas: { FirstInput: { type: "string" } },
    });
  });

  test("renders a cloned frozen document without replanning or losing prototype-named properties", () => {
    const document = planSchemaDocument([
      tool("First", { properties: { ["__proto__"]: { type: "string" } } }),
    ]);
    const cloned = structuredClone(document);
    freeze(cloned);
    const rendered = renderSchemaDocument(cloned);
    expect(renderSchemaDocument(cloned)).toBe(rendered);
    const evaluate = new Function("createSchemaDocument", `${rendered}\nreturn schemaDocument;`);
    expect(evaluate((value: unknown) => value)).toEqual(document);
  });
});

function freeze(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
