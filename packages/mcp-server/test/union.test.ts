import { describe, expect, test } from "bun:test";
import { createSchema, createSchemaDocument } from "../src/index.js";

const plain = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false,
};
const rich = {
  type: "object",
  properties: { value: { type: "string" }, data: { type: "string" } },
  required: ["value", "data"],
  additionalProperties: false,
};

describe("union schemas", () => {
  test("identity output projection preserves the matching object in either order", async () => {
    for (const anyOf of [
      [plain, rich],
      [rich, plain],
    ]) {
      const schema = createSchema({ schema: { anyOf } });
      const value = { value: "v", data: "kept" };
      expect(await schema.encode(value)).toEqual({ ok: true, value });
      expect((await schema.encode({ ...value, extra: true })).ok).toBe(false);
      expect(await schema.encode({ value: "v", extra: true })).toEqual({
        ok: true,
        value: { value: "v" },
      });
    }
  });

  test("uses branch wire constraints before decoding overlapping structural shapes", async () => {
    const schema = createSchema({
      schema: {
        anyOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }],
        $defs: {
          A: { ...plain, properties: { value: { type: "string", pattern: "^a" } } },
          B: { ...plain, properties: { value: { type: "string", pattern: "^b" } } },
        },
      },
      codec: {
        root: {
          kind: "union",
          variants: ["A", "B"].map((name) => ({
            kind: "object",
            wireSchema: { $ref: `#/$defs/${name}` },
            properties: {
              [name]: { wireName: "value", codec: { kind: "primitive", type: "string" } },
            },
          })),
        },
      },
    });
    expect(await schema.input["~standard"].validate({ value: "bee" })).toEqual({
      value: { B: "bee" },
    });
    expect(await schema.encode({ B: "bee" })).toEqual({ ok: true, value: { value: "bee" } });
    expect((await schema.encode({ A: "bee" })).ok).toBe(false);
  });

  test("wire validation retains valid overlapping forms without ambiguous input conversion", async () => {
    const schema = createSchema({
      schema: { type: "string" },
      codec: {
        root: {
          kind: "union",
          variants: [
            { kind: "number-string", numericConstraints: { maximum: "10" } },
            { kind: "primitive", type: "string" },
          ],
        },
      },
    });
    expect((await schema.input["~standard"].validate("9")).issues).toBeDefined();
    expect(await schema.encode(9)).toEqual({ ok: true, value: "9" });
    expect(await schema.validateWire("9")).toEqual({ ok: true, value: "9" });
    expect(await schema.validateWire("99")).toEqual({ ok: true, value: "99" });
  });

  test("hydrates definitions referenced only by codec branch schemas", async () => {
    const doc = createSchemaDocument({
      schemas: { Value: true },
      $defs: { Lower: { type: "string", pattern: "^[a-z]+$" }, Unused: { pattern: "[" } },
      codecs: { Value: { kind: "ref", name: "Value" } },
      codecDefinitions: {
        Value: {
          kind: "union",
          variants: [{ kind: "primitive", type: "string", wireSchema: { $ref: "#/$defs/Lower" } }],
        },
      },
    });
    const schema = doc.get("Value");
    expect(Object.keys(schema.jsonSchema.$defs as object)).toEqual(["Lower"]);
    expect(await schema.input["~standard"].validate("abc")).toEqual({ value: "abc" });
    expect((await schema.input["~standard"].validate("ABC")).issues).toBeDefined();
  });
});
