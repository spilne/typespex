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

  test("accepts equivalent alternatives and rejects incompatible coercions", () => {
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
    expect(() => decodeHttpWireValue("1", ambiguous)).toThrow("incompatible conversions");
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
});
