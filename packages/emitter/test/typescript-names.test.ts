import { describe, expect, test } from "bun:test";
import { tsLiteral } from "../src/typescript-names.js";

describe("TypeScript literal emission", () => {
  test("escapes characters that can break generated-code embedding contexts", () => {
    const value = {
      closingTag: "</script>",
      separators: "\u2028\u2029",
    };

    const literal = tsLiteral(value);

    expect(literal).toBe('{"closingTag":"\\u003C/script\\u003E","separators":"\\u2028\\u2029"}');
    expect(JSON.parse(literal)).toEqual(value);
  });
});
