/** Exact decimal bounds for numeric values whose wire format cannot use JSON Schema bounds. */
export interface NumericConstraints {
  readonly minimum?: string;
  readonly maximum?: string;
  readonly exclusiveMinimum?: string;
  readonly exclusiveMaximum?: string;
}

interface Decimal {
  readonly sign: -1 | 0 | 1;
  readonly digits: string;
  readonly magnitude: bigint;
}

const checks = [
  ["minimum", "at least", (order: number) => order >= 0],
  ["maximum", "at most", (order: number) => order <= 0],
  ["exclusiveMinimum", "greater than", (order: number) => order > 0],
  ["exclusiveMaximum", "less than", (order: number) => order < 0],
] as const;

export function numericConstraintIssue(
  value: unknown,
  constraints: NumericConstraints | undefined,
): string | undefined {
  if (!constraints) return undefined;
  if (
    (typeof value !== "string" && typeof value !== "bigint" && typeof value !== "number") ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    return "Expected a finite numeric value.";
  }
  const decimal = parseDecimal(String(value));
  if (!decimal) return "Expected a decimal numeric value.";
  for (const [key, description, accepts] of checks) {
    const bound = constraints[key];
    if (bound === undefined) continue;
    const parsed = parseDecimal(bound);
    if (!parsed) return `Codec plan contains an invalid ${key} bound.`;
    if (!accepts(compareDecimals(decimal, parsed))) {
      return `Expected a numeric value ${description} ${bound}.`;
    }
  }
  return undefined;
}

function parseDecimal(value: string): Decimal | undefined {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) return undefined;
  const [, sign, integer, fraction = "", exponent = "0"] = match;
  const coefficient = `${integer}${fraction}`;
  const digits = coefficient.replace(/^0+/, "").replace(/0+$/, "");
  if (digits.length === 0) return { sign: 0, digits: "", magnitude: 0n };
  const leadingZeros = coefficient.length - coefficient.replace(/^0+/, "").length;
  return {
    sign: sign === "-" ? -1 : 1,
    digits,
    // Never expand powers of ten: storage follows the input length, even for
    // exponents far beyond JavaScript's finite number range.
    magnitude: BigInt(integer!.length - leadingZeros) + BigInt(exponent),
  };
}

function compareDecimals(left: Decimal, right: Decimal): number {
  if (left.sign !== right.sign) return left.sign < right.sign ? -1 : 1;
  if (left.sign === 0) return 0;
  if (left.magnitude !== right.magnitude) {
    return (left.magnitude < right.magnitude ? -1 : 1) * left.sign;
  }
  const length = Math.max(left.digits.length, right.digits.length);
  for (let index = 0; index < length; index++) {
    const a = left.digits[index] ?? "0";
    const b = right.digits[index] ?? "0";
    if (a !== b) return (a < b ? -1 : 1) * left.sign;
  }
  return 0;
}
