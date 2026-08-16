import { describe, expect, test } from "bun:test";
import { ScalarEncodings } from "../src/scalar-encoding.js";

describe("protocol-neutral scalar encodings", () => {
  test("decodes decimal and boolean strings without losing numeric guarantees", () => {
    expect(ScalarEncodings.decodeNumberString("-1.25e2")).toBe(-125);
    expect(ScalarEncodings.decodeIntegerString("9007199254740991")).toBe(9_007_199_254_740_991);
    expect(ScalarEncodings.decodeBigIntString("-9223372036854775808")).toBe(
      -9_223_372_036_854_775_808n,
    );
    expect(ScalarEncodings.decodeBooleanString("TrUe")).toBe(true);
    expect(ScalarEncodings.decodeBooleanString("FALSE")).toBe(false);

    expect(() => ScalarEncodings.decodeNumberString("01")).toThrow("decimal number");
    expect(() => ScalarEncodings.decodeNumberString("1e309")).toThrow("finite number");
    expect(() => ScalarEncodings.decodeIntegerString("1.0")).toThrow("decimal integer");
    expect(() => ScalarEncodings.decodeIntegerString("9007199254740992")).toThrow("safe integer");
    expect(() => ScalarEncodings.decodeBigIntString("+1")).toThrow("decimal integer");
    expect(() => ScalarEncodings.decodeBigIntString("123456789012345678901")).toThrow(
      "supported 64-bit width",
    );
    expect(() => ScalarEncodings.decodeBooleanString("yes")).toThrow('"true" or "false"');
  });

  test("encodes numeric and boolean values with declared bounds", () => {
    expect(ScalarEncodings.encodeNumberString(12.5, { min: 0, max: 20 })).toBe("12.5");
    expect(ScalarEncodings.encodeBigIntString(12n, { min: 0n, max: 20n })).toBe("12");
    expect(ScalarEncodings.encodeBooleanString(false)).toBe("false");

    expect(() => ScalarEncodings.encodeNumberString(Number.NaN)).toThrow("finite number");
    expect(() => ScalarEncodings.encodeNumberString(1.5, { integer: true })).toThrow(
      "safe integer",
    );
    expect(() => ScalarEncodings.encodeNumberString(-1, { min: 0 })).toThrow("at least 0");
    expect(() => ScalarEncodings.encodeNumberString(21, { max: 20 })).toThrow("at most 20");
    expect(() => ScalarEncodings.encodeBigIntString(1 as never)).toThrow("bigint");
    expect(() => ScalarEncodings.encodeBooleanString("true" as never)).toThrow("boolean");
  });

  test("validates and converts RFC date-time formats", () => {
    expect(ScalarEncodings.decodeRfc3339DateTime("2024-02-29T23:59:59.125+02:30")).toBe(
      "2024-02-29T23:59:59.125+02:30",
    );
    expect(ScalarEncodings.decodeDateTimeDate("2016-12-31T23:59:60Z")).toEqual(
      new Date("2017-01-01T00:00:00.000Z"),
    );
    expect(ScalarEncodings.encodeRfc3339DateTime("2024-01-01t00:00:00z")).toBe(
      "2024-01-01t00:00:00z",
    );
    expect(ScalarEncodings.decodeRfc7231DateTime("Tue, 02 Jan 2024 03:04:05 GMT")).toBe(
      "2024-01-02T03:04:05.000Z",
    );
    expect(ScalarEncodings.encodeRfc7231DateTime("2024-01-02T03:04:05Z")).toBe(
      "Tue, 02 Jan 2024 03:04:05 GMT",
    );

    expect(() => ScalarEncodings.decodeRfc3339DateTime("2023-02-29T00:00:00Z")).toThrow(
      "valid RFC 3339 wire",
    );
    expect(() => ScalarEncodings.decodeRfc3339DateTime("2024-01-01")).toThrow("RFC 3339 wire");
    expect(() => ScalarEncodings.encodeRfc3339DateTime("2024-13-01T00:00:00Z")).toThrow(
      "valid RFC 3339 handler",
    );
    expect(() => ScalarEncodings.decodeRfc7231DateTime("2024-01-02T03:04:05Z")).toThrow(
      "IMF-fixdate",
    );
    expect(() => ScalarEncodings.decodeRfc7231DateTime("Tue, 31 Feb 2024 03:04:05 GMT")).toThrow(
      "valid RFC 7231",
    );
  });

  test("round-trips Unix timestamps with number and bigint wire types", () => {
    expect(ScalarEncodings.decodeUnixTimestamp(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(ScalarEncodings.decodeUnixTimestamp(1n)).toBe("1970-01-01T00:00:01.000Z");
    expect(ScalarEncodings.encodeUnixTimestamp("1970-01-01T00:00:01.999Z")).toBe(1);
    expect(
      ScalarEncodings.encodeUnixTimestamp("1970-01-01T00:00:01Z", {
        bigint: true,
        min: 0n,
        max: 2n,
      }),
    ).toBe(1n);

    expect(() => ScalarEncodings.decodeUnixTimestamp(1.5)).toThrow("integer Unix timestamp");
    expect(() => ScalarEncodings.decodeUnixTimestamp(9_000_000_000_000n)).toThrow(
      "supported date-time range",
    );
    expect(() => ScalarEncodings.encodeUnixTimestamp("1970-01-01T00:00:02Z", { max: 1 })).toThrow(
      "at most 1",
    );
  });

  test("validates ISO durations and converts fixed durations exactly", () => {
    expect(ScalarEncodings.decodeIsoDuration("P1Y2M3W4DT5H6M7.5S")).toBe("P1Y2M3W4DT5H6M7.5S");
    expect(ScalarEncodings.encodeIsoDuration("-PT0.25S")).toBe("-PT0.25S");
    expect(ScalarEncodings.decodeNumericDuration(1.5, "seconds")).toBe("PT1.5S");
    expect(ScalarEncodings.decodeNumericDuration(1500n, "milliseconds")).toBe("PT1.5S");
    expect(ScalarEncodings.decodeNumericDuration(-2n, "seconds")).toBe("-PT2S");
    expect(ScalarEncodings.decodeNumericDuration(0, "seconds")).toBe("PT0S");
    expect(ScalarEncodings.decodeNumericDuration(1e-7, "seconds")).toBe("PT0.0000001S");
    expect(ScalarEncodings.encodeNumericDuration("PT1H30.5M", "seconds")).toBe(5_430);
    expect(
      ScalarEncodings.encodeNumericDuration("P1W2DT3H4M5.5S", "milliseconds", {
        bigint: true,
      }),
    ).toBe(788_645_500n);
    expect(ScalarEncodings.encodeNumericDuration("-PT1.5S", "seconds", { integer: true })).toBe(-2);

    for (const invalid of ["P", "PT", "PT1.5H30M", "PT1.1234567890S"]) {
      expect(() => ScalarEncodings.decodeIsoDuration(invalid)).toThrow("ISO 8601 wire duration");
    }
    expect(() => ScalarEncodings.encodeIsoDuration("P0.5Y")).toThrow("ISO 8601 handler duration");
    expect(() =>
      ScalarEncodings.decodeNumericDuration(Number.POSITIVE_INFINITY, "seconds"),
    ).toThrow("finite duration");
    expect(() => ScalarEncodings.encodeNumericDuration("P1Y", "seconds")).toThrow(
      "containing only weeks",
    );
    expect(() => ScalarEncodings.encodeNumericDuration("PT2S", "seconds", { max: 1 })).toThrow(
      "at most 1",
    );
  });

  test("uses canonical base64 and base64url wire values", () => {
    const bytes = new Uint8Array([0, 127, 128, 255]);
    expect(ScalarEncodings.encodeBase64(bytes)).toBe("AH+A/w==");
    expect(ScalarEncodings.encodeBase64Url(bytes)).toBe("AH-A_w");
    expect(ScalarEncodings.decodeBase64Url("AH-A_w")).toEqual(bytes);
    expect(ScalarEncodings.decodeBase64Url("AH-A_w==")).toEqual(bytes);

    for (const invalid of ["a", "_w=", "_x", "***"]) {
      expect(() => ScalarEncodings.decodeBase64Url(invalid)).toThrow("valid base64url");
    }
    expect(() => ScalarEncodings.encodeBase64("bytes" as never)).toThrow("Uint8Array");
  });
});
