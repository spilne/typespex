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
