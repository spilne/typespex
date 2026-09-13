import { describe, expect, test } from "bun:test";
import { createValueCodec, type ValueCodecSpec } from "../src/index.js";

const plain: ValueCodecSpec = {
  kind: "object",
  properties: { value: { wireName: "value", codec: { kind: "primitive", type: "string" } } },
};
const rich: ValueCodecSpec = {
  kind: "object",
  properties: {
    value: { wireName: "value", codec: { kind: "primitive", type: "string" } },
    data: { wireName: "data", codec: { kind: "bytes" } },
  },
};

describe("union conversion", () => {
  test("compares nested array and tuple results independently of property order", async () => {
    if (rich.kind !== "object") throw new Error("Expected object fixture");
    const reordered: ValueCodecSpec = {
      ...rich,
      properties: Object.fromEntries(Object.entries(rich.properties).reverse()),
    };
    const codec = createValueCodec({
      root: {
        kind: "union",
        variants: [
          { kind: "array", item: rich },
          { kind: "tuple", items: [reordered] },
        ],
      },
    });
    const wire = [{ value: "v", data: "AQI=" }];
    const semantic = [{ value: "v", data: new Uint8Array([1, 2]) }];
    expect(await codec.decode(wire)).toEqual({ ok: true, value: semantic });
    expect(await codec.encode(semantic)).toEqual({ ok: true, value: wire });
    expect(await codec.decode([...wire, ...wire])).toEqual({
      ok: true,
      value: [...semantic, ...semantic],
    });
  });

  test("rejects ambiguous property renames and defaults on otherwise matching inputs", async () => {
    for (const defaulted of [false, true]) {
      const codec = createValueCodec({
        root: {
          kind: "union",
          variants: ["first", "second"].map((name) => ({
            kind: "object",
            properties: {
              [name]: {
                wireName: "value",
                codec: { kind: "primitive", type: "string" },
                ...(defaulted ? { hasDefault: true, defaultValue: "default" } : {}),
              },
            },
          })),
        },
      });
      const result = await codec.decode(defaulted ? {} : { value: "v" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues[0]?.message).toContain("incompatible conversions");
    }
  });

  test("preserves richer objects through references in either branch order", async () => {
    for (const names of [
      ["Plain", "Rich"],
      ["Rich", "Plain"],
    ]) {
      const codec = createValueCodec({
        root: { kind: "union", variants: names.map((name) => ({ kind: "ref", name })) },
        definitions: { Plain: plain, Rich: rich },
      });
      const semantic = { value: "kept", data: new Uint8Array([1, 2]) };
      const wire = { value: "kept", data: "AQI=" };
      expect(await codec.decode(wire)).toEqual({ ok: true, value: semantic });
      expect(await codec.encode(semantic)).toEqual({ ok: true, value: wire });
      expect(await codec.encode({ value: "plain" })).toEqual({
        ok: true,
        value: { value: "plain" },
      });
      expect((await codec.encode({ ...semantic, extra: true })).ok).toBe(false);
    }
  });

  test("rejects incompatible semantic interpretations while allowing valid wire output", async () => {
    const codec = createValueCodec({
      root: {
        kind: "union",
        variants: [
          { kind: "number-string", numericConstraints: { maximum: "10" } },
          { kind: "primitive", type: "string" },
        ],
      },
    });
    expect((await codec.decode("9")).ok).toBe(false);
    expect(await codec.decode("99")).toEqual({ ok: true, value: "99" });
    expect(await codec.encode(9)).toEqual({ ok: true, value: "9" });
    expect(await codec.validateWire("9")).toEqual({ ok: true, value: "9" });
  });

  test("accepts equivalent bytes, dates, files, and Temporal alternatives", async () => {
    for (const [spec, wire] of [
      [{ kind: "bytes" }, "AQI="],
      [{ kind: "date-time", format: "date-time", representation: "date" }, "2024-01-02T03:04:05Z"],
      [{ kind: "file" }, { name: "a.bin", data: "AQI=" }],
      [
        {
          kind: "date-time",
          format: "date",
          representation: "temporal",
          temporalKind: "plain-date",
        },
        "2024-01-02",
      ],
    ] as const) {
      const codec = createValueCodec({
        root: { kind: "union", variants: [spec, structuredClone(spec)] },
      });
      const decoded = await codec.decode(wire);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) expect((await codec.encode(decoded.value)).ok).toBe(true);
    }
  });

  test("does not choose a branch that exposes a field hidden by another matching branch", async () => {
    const codec = createValueCodec({
      root: {
        kind: "union",
        variants: [
          { ...plain, excludedProperties: { secret: "secret" } },
          {
            kind: "object",
            properties: {
              value: { wireName: "value", codec: { kind: "primitive", type: "string" } },
              secret: { wireName: "secret", codec: { kind: "primitive", type: "string" } },
            },
          },
        ],
      },
    });
    expect((await codec.encode({ value: "v", secret: "private" })).ok).toBe(false);
  });

  test("bounds repeated conversion of equivalent recursive branches and resets caches per call", async () => {
    const node: ValueCodecSpec = {
      kind: "object",
      properties: {
        data: { wireName: "data", codec: { kind: "bytes" } },
        child: { wireName: "child", optional: true, codec: { kind: "ref", name: "Node" } },
      },
    };
    const codec = createValueCodec({
      root: { kind: "ref", name: "Node" },
      definitions: {
        Node: { kind: "union", variants: [node, structuredClone(node)] },
      },
    });
    let reads = 0;
    const depth = 18;
    let value: Record<string, unknown> = { data: new Uint8Array([1]) };
    for (let index = 0; index < depth; index++) {
      const child = value;
      value = {
        data: new Uint8Array([1]),
        get child() {
          if (++reads > depth * 8) throw new Error("Repeated graph traversal");
          return child;
        },
      };
    }
    expect((await codec.encode(value)).ok).toBe(true);
    expect(reads).toBeLessThanOrEqual(depth * 2);
    value.data = new Uint8Array([2]);
    reads = 0;
    expect(await codec.encode(value)).toMatchObject({ ok: true, value: { data: "Ag==" } });
    const cyclic: Record<string, unknown> = { data: new Uint8Array([1]) };
    cyclic.child = cyclic;
    expect((await codec.encode(cyclic)).ok).toBe(false);
  });
  test("keeps decoded object defaults independent for each array item", async () => {
    const codec = createValueCodec<{ tags: string[] }[]>({
      root: {
        kind: "array",
        item: {
          kind: "object",
          properties: {
            tags: {
              wireName: "tags",
              codec: { kind: "array", item: { kind: "primitive", type: "string" } },
              hasDefault: true,
              defaultValue: [],
            },
          },
        },
      },
    });
    const decoded = await codec.decode([{}, {}]);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    decoded.value[0]!.tags.push("only-first");
    expect(decoded.value[1]!.tags).toEqual([]);
  });

  test("propagates nested ambiguity and invalid declared values instead of dropping them", async () => {
    const inner: ValueCodecSpec = {
      kind: "union",
      variants: ["p", "q"].map((wireName) => ({
        kind: "object",
        properties: { n: { wireName, codec: { kind: "primitive", type: "number" } } },
      })),
    };
    const richer: ValueCodecSpec = {
      kind: "object",
      properties: {
        value: { wireName: "value", codec: { kind: "primitive", type: "string" } },
        inner: { wireName: "inner", codec: inner },
      },
    };
    for (const variants of [
      [plain, richer],
      [richer, plain],
    ]) {
      const codec = createValueCodec({ root: { kind: "union", variants } });
      expect((await codec.encode({ value: "v", inner: { n: 1 } })).ok).toBe(false);
      expect((await codec.encode({ value: "v", inner: { n: "invalid" } })).ok).toBe(false);
      expect((await codec.encode({ value: "v", inner: {} })).ok).toBe(false);
    }
    const tagged: ValueCodecSpec = {
      ...richer,
      properties: {
        ...richer.properties,
        kind: { wireName: "kind", codec: { kind: "literal", value: "rich" } },
      },
    };
    const correct: ValueCodecSpec = {
      kind: "object",
      properties: {
        kind: { wireName: "kind", codec: { kind: "literal", value: "plain" } },
        value: { wireName: "value", codec: { kind: "primitive", type: "string" } },
        inner: { wireName: "inner", codec: { kind: "identity" } },
      },
    };
    const codec = createValueCodec({ root: { kind: "union", variants: [tagged, correct] } });
    const value = { kind: "plain", value: "v", inner: { n: 1 } };
    expect(await codec.encode(value)).toEqual({ ok: true, value });
  });

  test("bounds failing recursive alternatives and rebases cached issue paths", async () => {
    const node: ValueCodecSpec = {
      kind: "object",
      properties: {
        value: { wireName: "value", codec: { kind: "primitive", type: "string" } },
        child: { wireName: "child", optional: true, codec: { kind: "ref", name: "Node" } },
      },
    };
    const codec = createValueCodec({
      root: { kind: "ref", name: "Node" },
      definitions: { Node: { kind: "union", variants: [node, structuredClone(node)] } },
    });
    const depth = 20;
    for (const terminal of [{ value: "v", extra: true }, { value: 42 }]) {
      let reads = 0;
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
      const encoded = await codec.encode(value);
      expect(encoded.ok).toBe(typeof terminal.value === "string");
      expect(reads).toBeLessThanOrEqual(depth * 8);
      reads = 0;
      expect((await codec.decode(value)).ok).toBe(typeof terminal.value === "string");
      expect(reads).toBeLessThanOrEqual(depth * 8);
    }
    const shared = { value: 42 };
    const array = createValueCodec({ root: { kind: "array", item: node } });
    const failed = await array.decode([shared, shared]);
    expect(failed.ok).toBe(false);
    if (!failed.ok)
      expect(failed.issues.map((issue) => issue.path)).toEqual([
        [0, "value"],
        [1, "value"],
      ]);
  });
  test("preserves projection needs alongside ineligible open alternatives in either order", async () => {
    const node: ValueCodecSpec = {
      kind: "object",
      properties: {
        value: { wireName: "value", codec: { kind: "primitive", type: "string" } },
        child: { wireName: "child", optional: true, codec: { kind: "ref", name: "Node" } },
      },
    };
    const other: ValueCodecSpec = {
      kind: "object",
      additionalProperties: true,
      properties: { other: { wireName: "other", codec: { kind: "primitive", type: "string" } } },
    };
    const input = { value: "v", child: { value: "leaf", extra: true } };
    for (const variants of [
      [node, other],
      [other, node],
    ]) {
      const codec = createValueCodec({
        root: { kind: "ref", name: "Node" },
        definitions: { Node: { kind: "union", variants } },
      });
      expect(await codec.encode(input)).toEqual({
        ok: true,
        value: { value: "v", child: { value: "leaf" } },
      });
    }
  });
  test("lets exact siblings match after nullable and named union value failures", async () => {
    const object = (type: "number" | "string" | "boolean"): ValueCodecSpec => ({
      kind: "object",
      properties: {
        id: { wireName: "id", codec: { kind: "primitive", type } },
        payload: { wireName: "payload", codec: { kind: "bytes" } },
      },
    });
    const nullable = (variant: ValueCodecSpec): ValueCodecSpec => ({
      kind: "object",
      properties: {
        item: {
          wireName: "item",
          codec: { kind: "union", variants: [variant, { kind: "primitive", type: "null" }] },
        },
      },
    });
    for (const grouped of [false, true]) {
      const bad: ValueCodecSpec = grouped
        ? { kind: "ref", name: "Pet" }
        : nullable(object("number"));
      const good = grouped ? object("string") : nullable(object("string"));
      const semantic = { id: "r1", payload: new Uint8Array([1, 2]) };
      const wire = { id: "r1", payload: "AQI=" };
      for (const variants of [
        [bad, good],
        [good, bad],
      ]) {
        const codec = createValueCodec({
          root: { kind: "union", variants },
          definitions: { Pet: { kind: "union", variants: [object("number"), object("boolean")] } },
        });
        const input = grouped ? wire : { item: wire };
        const output = grouped ? semantic : { item: semantic };
        expect(await codec.decode(input)).toEqual({ ok: true, value: output });
        expect(await codec.encode(output)).toEqual({ ok: true, value: input });
      }
    }
  });
});
