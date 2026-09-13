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
});
