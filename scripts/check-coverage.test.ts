import { describe, expect, test } from "bun:test";
import { parseLcov, validateCoverage } from "./check-coverage";

function record(
  source: string,
  linesFound: number,
  linesHit: number,
  functionsFound: number,
  functionsHit: number,
): string {
  return [
    "TN:",
    `SF:${source}`,
    `FNF:${functionsFound}`,
    `FNH:${functionsHit}`,
    `LF:${linesFound}`,
    `LH:${linesHit}`,
    "end_of_record",
  ].join("\n");
}

describe("coverage validation", () => {
  test("aggregates the required source records", () => {
    const report = [
      record("src/one.ts", 100, 96, 50, 47),
      record("src/two.ts", 100, 95, 50, 47),
      record("ignored.ts", 100, 0, 100, 0),
    ].join("\n");

    expect(validateCoverage(report, ["src/one.ts", "src/two.ts"])).toEqual({
      files: 2,
      functions: { found: 100, hit: 94, ratio: 0.94 },
      lines: { found: 200, hit: 191, ratio: 0.955 },
    });
  });

  test("fails when an expected source was never loaded", () => {
    expect(() => validateCoverage(record("src/one.ts", 10, 10, 2, 2), ["src/missing.ts"])).toThrow(
      "Missing coverage records:\n- src/missing.ts",
    );
  });

  test("fails aggregate line and function regressions", () => {
    const lowLines = record("src/one.ts", 100, 94, 100, 100);
    expect(() => validateCoverage(lowLines, ["src/one.ts"])).toThrow(
      "Line coverage 94.00% is below 95.00%.",
    );

    const lowFunctions = record("src/one.ts", 100, 100, 100, 93);
    expect(() => validateCoverage(lowFunctions, ["src/one.ts"])).toThrow(
      "Function coverage 93.00% is below 94.00%.",
    );
  });

  test("rejects malformed or duplicate LCOV records", () => {
    expect(() => parseLcov("TN:\nSF:src/one.ts\nLF:1\nLH:1\nend_of_record")).toThrow(
      "Invalid or missing FNF metric",
    );

    const duplicate = record("src/one.ts", 1, 1, 1, 1).repeat(2);
    expect(() => parseLcov(duplicate)).toThrow("Duplicate LCOV record: src/one.ts");
  });
});
