import { describe, expect, test } from "bun:test";
import {
  compareNumericStrings,
  createValueCodec,
  type NumericConstraints,
  type ValueCodecSpec,
} from "../src/index.js";

describe("exact numeric constraints", () => {
  test("orders signed zero and nearby decimals exactly", () => {
    const ordered = ["-1", "-0.1", "-0.01", "0", "0.001", "0.01", "0.1", "1"];
    for (let left = 0; left < ordered.length; left++) {
      for (let right = 0; right < ordered.length; right++) {
        expect(Math.sign(compareNumericStrings(ordered[left]!, ordered[right]!))).toBe(
          Math.sign(left - right),
        );
      }
    }
    expect(compareNumericStrings("-0.0e99999", "0")).toBe(0);
    expect(() => compareNumericStrings("invalid", "0")).toThrow(TypeError);
  });

  test("handles long coefficients and exponent carries without expensive numeric parsing", () => {
    const zeros = "0".repeat(20_000);
    expect(compareNumericStrings(`0.${zeros}1`, `0.${zeros}2`)).toBe(-1);
    const nines = "9".repeat(10_000);
    const powerOfTen = `1${"0".repeat(10_000)}`;
    expect(compareNumericStrings(`10e${nines}`, `1e${powerOfTen}`)).toBe(0);
    expect(compareNumericStrings(`1e-${nines}`, `10e-${powerOfTen}`)).toBe(0);
    expect(compareNumericStrings(`1e${nines}`, "1")).toBe(1);
    expect(compareNumericStrings(`1e-${nines}`, "1")).toBe(-1);
  });

  test("enforces integer limits without losing precision on either boundary", async () => {
    const codec = createValueCodec<bigint>({
      root: {
        kind: "bigint-string",
        numericConstraints: { minimum: "0", maximum: "18446744073709551615" },
      },
    });
    for (const value of [0n, 18446744073709551615n]) {
      expect(await codec.decode(String(value))).toEqual({ ok: true, value });
      expect(await codec.encode(value)).toEqual({ ok: true, value: String(value) });
    }
    for (const value of [-1n, 18446744073709551616n]) {
      expect((await codec.decode(String(value))).ok).toBe(false);
      expect((await codec.encode(value)).ok).toBe(false);
    }
  });

  test("compares exact decimals, exclusive boundaries, equivalent spellings, and huge exponents", async () => {
    const cases: readonly [NumericConstraints, readonly string[], readonly string[]][] = [
      [
        { minimum: "1.000000000000000001", maximum: "1.000000000000000003" },
        ["1.000000000000000001", "1.000000000000000002"],
        ["1", "1.000000000000000004"],
      ],
      [
        { exclusiveMinimum: "-0.01", exclusiveMaximum: "0.01" },
        ["-0.009", "0", "-0e99999999999999999999", "9e-3"],
        ["-0.01", "1e-2", "0.02", "-1e99999999999999999999", "1e99999999999999999999"],
      ],
      [
        { minimum: "12.5", maximum: "12.5" },
        ["12.50", "125e-1", "1.25e1"],
        ["12.49", "12.51", "1e-99999999999999999999"],
      ],
      [{ minimum: "-1.2", maximum: "-1.1" }, ["-1.2", "-1.15", "-1.10"], ["-1.21", "-1.09", "0"]],
    ];
    for (const [numericConstraints, accepted, rejected] of cases) {
      const codec = createValueCodec<string>({
        root: { kind: "decimal-string", numericConstraints },
      });
      for (const value of accepted) {
        expect(await codec.decode(value)).toEqual({ ok: true, value });
        expect(await codec.encode(value)).toEqual({ ok: true, value });
      }
      for (const value of rejected) {
        expect((await codec.decode(value)).ok).toBe(false);
        expect((await codec.encode(value)).ok).toBe(false);
      }
    }
  });

  test("checks values before and after number conversion and reports nested paths", async () => {
    const numeric: ValueCodecSpec = {
      kind: "number-string",
      numericConstraints: { exclusiveMaximum: "1" },
    };
    const codec = createValueCodec<{ count: number }>({
      root: { kind: "object", properties: { count: { wireName: "wire_count", codec: numeric } } },
    });
    expect(await codec.decode({ wire_count: "0.5" })).toEqual({ ok: true, value: { count: 0.5 } });
    for (const value of ["1", "0.99999999999999999999999"]) {
      expect(await codec.decode({ wire_count: value })).toMatchObject({
        ok: false,
        issues: [{ path: ["wire_count"] }],
      });
    }
    expect(await codec.encode({ count: 1 })).toMatchObject({
      ok: false,
      issues: [{ path: ["count"] }],
    });
  });

  test("rejects invalid numeric tokens and invalid plans", async () => {
    const codec = createValueCodec<unknown>({
      root: { kind: "decimal-string", numericConstraints: { minimum: "0" } },
    });
    for (const value of [null, {}, true, Infinity, NaN, "", "NaN", "01", "+1", "1.", ".1"]) {
      expect((await codec.decode(value)).ok).toBe(false);
      expect((await codec.encode(value)).ok).toBe(false);
    }
    const invalid = createValueCodec({
      root: { kind: "number-string", numericConstraints: { minimum: "invalid" } },
    });
    expect((await invalid.decode("1")).ok).toBe(false);
  });
});
