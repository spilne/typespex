import { describe, expect, test } from "bun:test";
import { parseJsonText } from "../src/http/json-value.js";

describe("lossless JSON values", () => {
  test("parses ordinary nested values with normal object prototypes", () => {
    const text = '{"name":"Pet","items":[{"id":1,"enabled":true},null],"constructor":"data"}';
    const value = parseJsonText(text) as Record<string, unknown>;
    expect(value).toEqual(JSON.parse(text));
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });

  test("preserves exact integers, exponent spellings, and negative zero", () => {
    const value = parseJsonText(
      "[9223372036854775807,18446744073709551615,9007199254740993.0,90071992547409930e-1,-0,0.5]",
    );
    expect(value).toEqual([
      9223372036854775807n,
      18446744073709551615n,
      9007199254740993n,
      9007199254740993n,
      -0,
      0.5,
    ]);
    expect(() => parseJsonText("[123456789012345678901]")).toThrow(SyntaxError);
  });

  test("native JSON spellings retain numeric boundaries and formatted input", () => {
    const values: ReadonlyArray<readonly [string, number | bigint]> = [
      ["999999999999999", 999999999999999],
      ["1000000000000000", 1000000000000000],
      ["9007199254740991", Number.MAX_SAFE_INTEGER],
      ["9007199254740992", 9007199254740992n],
      ["9.007199254740992e15", 9007199254740992n],
      ["1e19", 10000000000000000000n],
      ["1e20", 1e20],
      ["1e+21", 1e21],
      ["1e-7", 1e-7],
      ["1.000000000000001", 1.000000000000001],
      ["-0", -0],
      ["-0.0", -0],
    ];
    for (const [token, value] of values) {
      expect(parseJsonText(token), token).toBe(value);
      expect(parseJsonText(` { "value": ${token} } `), token).toEqual({ value });
    }
  });

  test("native JSON round trips preserve strings, numeric keys, and prototype data", () => {
    for (const value of [
      { name: "Pet name", quote: '"', slash: "\\", newline: "\n" },
      { unicode: "日本語 🦊", loneSurrogate: "\ud800" },
      JSON.parse('{"__proto__":{"marker":true},"toJSON":"data"}'),
      { items: [{ id: 1 }, { id: 2 }], constructor: "data" },
    ]) {
      for (const text of [JSON.stringify(value), JSON.stringify(value, null, 2)]) {
        expect(parseJsonText(text)).toEqual(value);
      }
    }
    expect(parseJsonText('{"2":"second","1":"first"}')).toEqual({
      "1": "first",
      "2": "second",
    });
    expect(() => parseJsonText('{"id":1,"id":2,"text":"\ud800"}')).toThrow(SyntaxError);
  });

  test("parsing does not invoke inherited serialization hooks", () => {
    for (const prototype of [Object.prototype, Array.prototype]) {
      const previous = Object.getOwnPropertyDescriptor(prototype, "toJSON");
      let calls = 0;
      let value: unknown;
      try {
        Object.defineProperty(prototype, "toJSON", {
          configurable: true,
          get() {
            calls++;
            throw new Error("Parsing must not read serialization hooks.");
          },
        });
        value = parseJsonText('{"items":[{"id":1}]}');
      } finally {
        if (previous) Object.defineProperty(prototype, "toJSON", previous);
        else Reflect.deleteProperty(prototype, "toJSON");
      }
      expect(calls).toBe(0);
      expect(value).toEqual({ items: [{ id: 1 }] });
    }
  });

  test("preserves literal and escaped prototype keys as own data", () => {
    for (const key of ['"__proto__"', String.raw`"\u005f\u005fproto\u005f\u005f"`]) {
      const value = parseJsonText(
        `{"nested":{${key}:{"marker":"data"},"id":9223372036854775807}}`,
      ) as { nested: Record<string, unknown> };
      expect(Object.getPrototypeOf(value.nested)).toBe(Object.prototype);
      expect(Object.getOwnPropertyDescriptor(value.nested, "__proto__")).toEqual({
        value: { marker: "data" },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      expect(value.nested.id).toBe(9223372036854775807n);
    }
  });

  test("keeps duplicate-key behavior for equal and conflicting values", () => {
    expect(parseJsonText('{"id":1,"id":1}')).toEqual({ id: 1 });
    expect(parseJsonText('{"item":{"id":1},"item":{"id":1}}')).toEqual({ item: { id: 1 } });
    expect(() => parseJsonText('{"id":1,"id":2}')).toThrow(SyntaxError);
    expect(() => parseJsonText(String.raw`{"id":1,"\u0069d":2}`)).toThrow(SyntaxError);
  });

  test("equal duplicate containers retain the last value's shape and property order", () => {
    for (const text of [
      '{"a":{},"a":[]}',
      '{"a":[],"a":{}}',
      '{"a":[1],"a":{"0":1}}',
      '{"a":{"0":1},"a":[1]}',
      '{"a":{"x":1,"y":2},"a":{"y":2,"x":1}}',
    ]) {
      expect(JSON.stringify(parseJsonText(text))).toBe(JSON.stringify(JSON.parse(text)));
    }
  });

  test("rejects malformed JSON before values reach a decoder", () => {
    for (const text of [
      "",
      "[1,]",
      '{"id":1,}',
      "{id:1}",
      '{"id":01}',
      "[+1]",
      "[.5]",
      "[1.]",
      "[1e]",
      "[e5]",
      "[E-1]",
      "[.5e3]",
      '{"a":.5}',
      "[undefined]",
      "[NaN]",
      "true false",
      "[1]\u00a0",
      '"raw\nnewline"',
      String.raw`"bad\x20escape"`,
      String.raw`"bad\u00ggescape"`,
    ]) {
      expect(() => parseJsonText(text), JSON.stringify(text)).toThrow(SyntaxError);
    }
  });
});
