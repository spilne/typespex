import { describe, expect, test } from "bun:test";
import { createTestHost, createTestRunner } from "@typespec/compiler/testing";
import type { Scalar } from "@typespec/compiler";
import {
  getEffectiveScalarEncoding,
  getScalarEncodingIssue,
  getScalarIntrinsicName,
  isIntegerIntrinsic,
  isJsonSafeIntegerRange,
  isNumericIntrinsic,
} from "../src/unstable.js";

const integers = [
  "int8",
  "uint8",
  "int16",
  "uint16",
  "int32",
  "uint32",
  "int64",
  "uint64",
  "integer",
  "safeint",
];
const numerics = [...integers, "float", "float32", "float64", "numeric", "decimal", "decimal128"];

async function compile(source: string) {
  const runner = await createTestRunner(await createTestHost());
  const [, diagnostics] = await runner.compileAndDiagnose(source);
  expect(diagnostics).toHaveLength(0);
  return runner.program;
}

describe("shared scalar policy", () => {
  test("classifies intrinsic numeric domains without choosing JavaScript representations", () => {
    for (const name of [...numerics, "boolean", "string", "bytes", "utcDateTime", "Custom"]) {
      expect(isIntegerIntrinsic(name)).toBe(integers.includes(name));
      expect(isNumericIntrinsic(name)).toBe(numerics.includes(name));
    }
  });

  test("accepts exactly the declared scalar encoding compatibility matrix", () => {
    const matrix: readonly [string | undefined, readonly string[], readonly string[]][] = [
      [undefined, [...numerics, "boolean"], ["string"]],
      ["rfc3339", ["utcDateTime", "offsetDateTime"], ["string"]],
      ["rfc7231", ["utcDateTime", "offsetDateTime"], ["string"]],
      ["unixTimestamp", ["utcDateTime"], integers],
      ["ISO8601", ["duration"], ["string"]],
      ["seconds", ["duration"], numerics],
      ["milliseconds", ["duration"], numerics],
      ["base64", ["bytes"], ["string"]],
      ["base64url", ["bytes"], ["string"]],
      ["custom", [], []],
      ["string", [], []],
    ];
    const names = [
      ...numerics,
      "string",
      "boolean",
      "utcDateTime",
      "offsetDateTime",
      "plainDate",
      "plainTime",
      "duration",
      "bytes",
      "Custom",
    ];
    for (const [encoding, semantics, wires] of matrix) {
      for (const semantic of names) {
        for (const wire of names) {
          expect(getScalarEncodingIssue(semantic, wire, encoding) === undefined).toBe(
            semantics.includes(semantic) && wires.includes(wire),
          );
        }
      }
    }
    expect(getScalarEncodingIssue("boolean", "boolean", undefined)).toBe(
      'the string encoding must encode as TypeSpec "string"',
    );
    expect(getScalarEncodingIssue("string", "string", undefined)).toBe(
      'the string encoding is not supported for semantic scalar "string"',
    );
    expect(getScalarEncodingIssue("bytes", "string", "hex")).toBe(
      'custom encoding "hex" is not supported',
    );
  });

  test("retains the encoding declaration source through inheritance and overrides", async () => {
    const program = await compile(`
      @encode("rfc7231") scalar DateHeader extends utcDateTime;
      scalar InheritedDate extends DateHeader;
      scalar Custom;
      model Values {
        inherited: InheritedDate;
        @encode("rfc3339") overridden: InheritedDate;
        plain: string;
      }
    `);
    const global = program.getGlobalNamespaceType();
    const base = global.scalars.get("DateHeader")!;
    const inherited = global.scalars.get("InheritedDate")!;
    const properties = global.models.get("Values")!.properties;
    const override = properties.get("overridden")!;
    expect(getScalarIntrinsicName(program, inherited)).toBe("utcDateTime");
    expect(getScalarIntrinsicName(program, global.scalars.get("Custom")!)).toBe("Custom");
    expect(getEffectiveScalarEncoding(program, inherited)?.source).toBe(base);
    expect(
      getEffectiveScalarEncoding(program, inherited, properties.get("inherited"))?.source,
    ).toBe(base);
    const encoding = getEffectiveScalarEncoding(program, inherited, override);
    expect(encoding?.source).toBe(override);
    expect(encoding?.data.encoding).toBe("rfc3339");
    expect(getEffectiveScalarEncoding(program, global.scalars.get("Custom")!)).toBeUndefined();
    expect(
      getEffectiveScalarEncoding(
        program,
        properties.get("plain")!.type as Scalar,
        properties.get("plain"),
      ),
    ).toBeUndefined();
  });

  test("uses property bounds with scalar fallbacks without rounding unsafe or fractional limits", async () => {
    const program = await compile(`
      @minValue(-100) @maxValue(100) scalar Bounded extends int64;
      @minValueExclusive(-100) @maxValueExclusive(100) scalar Exclusive extends int64;
      model Values {
        bounded: Bounded;
        exclusive: Exclusive;
        @minValue(-10) narrowed: Bounded;
        @minValue(-9007199254740991) @maxValue(9007199254740991) boundary: int64;
        @minValue(-9007199254740993) @maxValue(9007199254740993) unsafe: int64;
        @minValue(-10) missingMaximum: int64;
        @maxValue(10) missingMinimum: int64;
        unbounded: int64;
        @minValue(0.5) @maxValue(10) fractional: float64;
      }
    `);
    const global = program.getGlobalNamespaceType();
    const bounded = global.scalars.get("Bounded")!;
    expect(isJsonSafeIntegerRange(program, bounded, bounded)).toBe(true);
    for (const property of global.models.get("Values")!.properties.values()) {
      expect(isJsonSafeIntegerRange(program, property.type as Scalar, property)).toBe(
        ["bounded", "exclusive", "narrowed", "boundary"].includes(property.name),
      );
    }
  });
});
