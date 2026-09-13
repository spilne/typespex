import { describe, expect, test } from "bun:test";
import type { HttpWireValuePlan } from "@typespex/http-client";
import { decodeHttpWireValue, encodeHttpWireValue } from "../src/wire-values.js";

const plain: HttpWireValuePlan = {
  kind: "object",
  properties: {
    value: { sourceName: "value", value: { kind: "string" } },
  },
};
const rich: HttpWireValuePlan = {
  kind: "object",
  properties: {
    value: { sourceName: "value", value: { kind: "string" } },
    data: { sourceName: "payload", value: { kind: "scalar-encoding", encoding: "base64url" } },
  },
};

describe("HTTP union conversion", () => {
  test("preserves richer renamed and encoded fields in either branch order", () => {
    for (const variants of [
      [plain, rich],
      [rich, plain],
    ]) {
      const plan: HttpWireValuePlan = { kind: "array", item: { kind: "union", variants } };
      const canonical = [{ value: "v", data: "AQI=" }];
      const http = [{ value: "v", payload: "AQI" }];
      expect(decodeHttpWireValue(http, plan)).toEqual(canonical);
      expect(encodeHttpWireValue(canonical, plan)).toEqual(http);
      expect(() => encodeHttpWireValue([{ ...canonical[0], extra: true }], plan)).toThrow(
        "incompatible conversions",
      );
      expect(() => decodeHttpWireValue([{ ...http[0], extra: true }], plan)).toThrow(
        "incompatible conversions",
      );
    }
  });

  test("accepts equivalent alternatives and prefers exact wire types", () => {
    const equivalent: HttpWireValuePlan = {
      kind: "union",
      variants: [rich, structuredClone(rich)],
    };
    expect(decodeHttpWireValue({ value: "v", payload: "AQI" }, equivalent)).toEqual({
      value: "v",
      data: "AQI=",
    });
    const ambiguous: HttpWireValuePlan = {
      kind: "union",
      variants: [{ kind: "number" }, { kind: "string" }],
    };
    expect(decodeHttpWireValue("1", ambiguous)).toBe("1");
    expect(encodeHttpWireValue(1, ambiguous)).toBe(1);
    expect(encodeHttpWireValue("1", ambiguous)).toBe("1");
  });

  test("does not overwrite renamed properties with additional properties", () => {
    const plan: HttpWireValuePlan = {
      kind: "object",
      properties: {
        semantic: { sourceName: "wire", value: { kind: "string" } },
      },
      additional: { kind: "string" },
    };
    expect(() => decodeHttpWireValue({ wire: "declared", semantic: "extra" }, plan)).toThrow(
      "collides",
    );
    expect(() => encodeHttpWireValue({ semantic: "declared", wire: "extra" }, plan)).toThrow(
      "collides",
    );
    const optional: HttpWireValuePlan = {
      ...plan,
      properties: { semantic: { ...plan.properties.semantic!, optional: true } },
    };
    expect(() => decodeHttpWireValue({ semantic: "bypassed" }, optional)).toThrow("collides");
    expect(() => encodeHttpWireValue({ wire: "bypassed" }, optional)).toThrow("collides");
  });

  test("bounds equivalent recursive conversion and rejects cyclic values", () => {
    const node: HttpWireValuePlan = {
      kind: "object",
      properties: {
        value: { sourceName: "value", value: { kind: "string" } },
        child: { sourceName: "child", optional: true, value: { kind: "ref", name: "Node" } },
      },
    };
    const plan: HttpWireValuePlan = {
      kind: "definition",
      name: "Node",
      value: { kind: "union", variants: [node, structuredClone(node)] },
    };
    for (const convert of [decodeHttpWireValue, encodeHttpWireValue]) {
      const depth = 18;
      let reads = 0;
      let value: Record<string, unknown> = { value: "v" };
      for (let index = 0; index < depth; index++) {
        const child = value;
        value = {
          value: "v",
          get child() {
            if (++reads > depth * 4) throw new Error("Repeated traversal");
            return child;
          },
        };
      }
      expect(convert(value, plan)).toMatchObject({ value: "v" });
      expect(reads).toBeLessThanOrEqual(depth * 2);
      const cyclic: Record<string, unknown> = { value: "v" };
      cyclic.child = cyclic;
      expect(() => convert(cyclic, plan)).toThrow();
    }
  });
  test("prefers exact scalar and collection shapes while retaining fallback coercions", () => {
    for (const [first, second, value] of [
      [{ kind: "number" }, { kind: "string" }, "42"],
      [{ kind: "boolean" }, { kind: "string" }, "true"],
      [{ kind: "array", item: { kind: "string" } }, { kind: "string" }, "a"],
      [{ kind: "array", item: plain }, plain, { value: "v" }],
    ] as const) {
      for (const variants of [
        [first, second],
        [second, first],
      ])
        expect(decodeHttpWireValue(value, { kind: "union", variants })).toEqual(value);
    }
    expect(
      decodeHttpWireValue("42", {
        kind: "union",
        variants: [{ kind: "number" }, { kind: "null" }],
      }),
    ).toBe(42);
    expect(
      decodeHttpWireValue("a", {
        kind: "union",
        variants: [{ kind: "array", item: { kind: "string" } }, { kind: "null" }],
      }),
    ).toEqual(["a"]);
    expect(() =>
      decodeHttpWireValue("42", {
        kind: "union",
        variants: [{ kind: "scalar-encoding", encoding: "integer-string" }, { kind: "string" }],
      }),
    ).toThrow("incompatible conversions");
  });

  test("does not swallow a nested ambiguity or invalid richer field", () => {
    const inner: HttpWireValuePlan = {
      kind: "union",
      variants: ["p", "q"].map((sourceName) => ({
        kind: "object",
        properties: { n: { sourceName, value: { kind: "number" } } },
      })),
    };
    const richer: HttpWireValuePlan = {
      kind: "object",
      properties: {
        value: { sourceName: "value", value: { kind: "string" } },
        inner: { sourceName: "inner", value: inner },
      },
    };
    for (const variants of [
      [plain, richer],
      [richer, plain],
    ]) {
      expect(() =>
        encodeHttpWireValue({ value: "v", inner: { n: 1 } }, { kind: "union", variants }),
      ).toThrow("incompatible conversions");
      expect(() =>
        encodeHttpWireValue({ value: "v", inner: { n: "invalid" } }, { kind: "union", variants }),
      ).toThrow();
      expect(() =>
        encodeHttpWireValue({ value: "v", inner: {} }, { kind: "union", variants }),
      ).toThrow();
    }
    const numeric: HttpWireValuePlan = {
      kind: "object",
      properties: {
        value: { sourceName: "value", value: { kind: "string" } },
        count: {
          sourceName: "count",
          value: {
            kind: "union",
            variants: [{ kind: "scalar-encoding", encoding: "integer-string" }, { kind: "string" }],
          },
        },
      },
    };
    expect(() =>
      decodeHttpWireValue(
        { value: "v", count: "1" },
        { kind: "union", variants: [plain, numeric] },
      ),
    ).toThrow("incompatible conversions");
    const tagged: HttpWireValuePlan = {
      ...richer,
      properties: {
        ...richer.properties,
        kind: { sourceName: "kind", value: { kind: "literal", value: "rich" } },
      },
    };
    const correct: HttpWireValuePlan = {
      kind: "object",
      properties: {
        kind: { sourceName: "kind", value: { kind: "literal", value: "plain" } },
        value: { sourceName: "value", value: { kind: "string" } },
        inner: { sourceName: "inner", value: { kind: "identity" } },
      },
    };
    const value = { kind: "plain", value: "v", inner: { n: 1 } };
    expect(encodeHttpWireValue(value, { kind: "union", variants: [tagged, correct] })).toEqual(
      value,
    );
  });

  test("bounds failing recursive alternatives before trying permissive projection", () => {
    const node: HttpWireValuePlan = {
      kind: "object",
      properties: {
        value: { sourceName: "value", value: { kind: "string" } },
        child: { sourceName: "child", optional: true, value: { kind: "ref", name: "Node" } },
      },
    };
    const plan: HttpWireValuePlan = {
      kind: "definition",
      name: "Node",
      value: { kind: "union", variants: [node, structuredClone(node)] },
    };
    for (const convert of [decodeHttpWireValue, encodeHttpWireValue]) {
      for (const terminal of [{ value: "v", extra: true }, { value: 42 }]) {
        const depth = 20;
        let reads = 0;
        let value: Record<string, unknown> = terminal;
        for (let index = 0; index < depth; index++) {
          const child = value;
          value = {
            value: "v",
            get child() {
              if (++reads > depth * 20) throw new Error("Repeated failing traversal");
              return child;
            },
          };
        }
        if (typeof terminal.value === "string")
          expect(convert(value, plan)).toMatchObject({ value: "v" });
        else expect(() => convert(value, plan)).toThrow("HTTP");
        expect(reads).toBeLessThanOrEqual(depth * 16);
      }
    }
  });
  test("preserves projection needs alongside ineligible open alternatives in either order", () => {
    const node: HttpWireValuePlan = {
      kind: "object",
      properties: {
        value: { sourceName: "value", value: { kind: "string" } },
        child: { sourceName: "child", optional: true, value: { kind: "ref", name: "Node" } },
      },
    };
    const other: HttpWireValuePlan = {
      kind: "object",
      additional: { kind: "identity" },
      properties: { other: { sourceName: "other", value: { kind: "string" } } },
    };
    const input = { value: "v", child: { value: "leaf", extra: true } };
    for (const variants of [
      [node, other],
      [other, node],
    ]) {
      const plan: HttpWireValuePlan = {
        kind: "definition",
        name: "Node",
        value: { kind: "union", variants },
      };
      for (const convert of [encodeHttpWireValue, decodeHttpWireValue])
        expect(convert(input, plan)).toEqual({ value: "v", child: { value: "leaf" } });
    }
  });
});
