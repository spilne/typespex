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
  test("preserves nested projection failures and ignores mismatched discriminators", async () => {
    const inner = {
      anyOf: ["a", "b"].map((name) => ({
        type: "object",
        properties: { [name]: { type: "number" } },
        required: [name],
        additionalProperties: false,
      })),
    };
    const richer = {
      ...rich,
      properties: { value: { type: "string" }, inner },
      required: ["value", "inner"],
    };
    for (const anyOf of [
      [plain, richer],
      [richer, plain],
    ]) {
      const schema = createSchema({ schema: { anyOf } });
      expect((await schema.encode({ value: "v", inner: { a: 1, b: 2 } })).ok).toBe(false);
      expect((await schema.encode({ value: "v", inner: { a: "invalid" } })).ok).toBe(false);
      expect((await schema.encode({ value: "v", inner: {} })).ok).toBe(false);
    }
    const wrong = {
      ...richer,
      properties: { ...richer.properties, kind: { const: "rich" } },
      required: ["value", "inner", "kind"],
    };
    const correct = {
      ...wrong,
      properties: { ...wrong.properties, kind: { const: "plain" }, inner: true },
    };
    const schema = createSchema({ schema: { anyOf: [wrong, correct] } });
    const value = { value: "v", kind: "plain", inner: { a: 1, b: 2 } };
    expect(await schema.encode(value)).toEqual({ ok: true, value });
  });

  test("bounds repeated failing recursive projections", async () => {
    const node = {
      type: "object",
      properties: { value: { type: "string" }, child: { $ref: "#/$defs/Node" } },
      required: ["value"],
      additionalProperties: false,
    };
    const schema = createSchema({
      schema: { $ref: "#/$defs/Node", $defs: { Node: { anyOf: [node, structuredClone(node)] } } },
    });
    for (const terminal of [{ value: "v", extra: true }, { value: 42 }]) {
      let reads = 0;
      const depth = 20;
      let value: Record<string, unknown> = terminal;
      for (let index = 0; index < depth; index++) {
        const child = value;
        value = {
          value: "v",
          get child() {
            if (++reads > depth * 12) throw new Error("Repeated failing traversal");
            return child;
          },
        };
      }
      expect((await schema.encode(value)).ok).toBe(typeof terminal.value === "string");
      expect(reads).toBeLessThanOrEqual(depth * 8);
    }
  });
  test("preserves projection needs alongside ineligible open alternatives in either order", async () => {
    const node = {
      type: "object",
      properties: { value: { type: "string" }, child: { $ref: "#/$defs/Node" } },
      required: ["value"],
      additionalProperties: false,
    };
    const other = {
      type: "object",
      properties: { other: { type: "string" } },
      required: ["other"],
      additionalProperties: true,
    };
    for (const anyOf of [
      [node, other],
      [other, node],
    ]) {
      const schema = createSchema({ schema: { $ref: "#/$defs/Node", $defs: { Node: { anyOf } } } });
      expect(await schema.encode({ value: "v", child: { value: "leaf", extra: true } })).toEqual({
        ok: true,
        value: { value: "v", child: { value: "leaf" } },
      });
    }
  });
  test("lets exact siblings match after nullable and named union value failures", async () => {
    const object = (type: string) => ({
      type: "object",
      properties: { id: { type } },
      required: ["id"],
      additionalProperties: false,
    });
    const nullable = (variant: object) => ({
      type: "object",
      properties: { item: { anyOf: [variant, { type: "null" }] } },
      required: ["item"],
      additionalProperties: false,
    });
    for (const grouped of [false, true]) {
      const bad = grouped ? { $ref: "#/$defs/Pet" } : nullable(object("number"));
      const good = grouped ? object("string") : nullable(object("string"));
      const value = grouped ? { id: "r1" } : { item: { id: "r1" } };
      for (const anyOf of [
        [bad, good],
        [good, bad],
      ]) {
        const schema = createSchema({
          schema: { anyOf, $defs: { Pet: { anyOf: [object("number"), object("boolean")] } } },
        });
        expect(await schema.encode(value)).toEqual({ ok: true, value });
      }
    }
  });
});
