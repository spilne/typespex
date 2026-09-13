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
  readonly magnitude: DecimalInteger;
}

interface DecimalInteger {
  readonly sign: -1 | 0 | 1;
  readonly digits: string;
}

const asciiDecoder = new TextDecoder();

const checks = [
  ["minimum", "at least", (order: number) => order >= 0],
  ["maximum", "at most", (order: number) => order <= 0],
  ["exclusiveMinimum", "greater than", (order: number) => order > 0],
  ["exclusiveMaximum", "less than", (order: number) => order < 0],
] as const;

/** Compare exact decimal strings, including signed zero, without numeric rounding. */
export function compareNumericStrings(left: string, right: string): number {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  if (!a || !b) throw new TypeError("Expected decimal numeric strings.");
  return compareDecimals(a, b);
}

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
  let start = 0;
  while (start < coefficient.length && coefficient[start] === "0") start++;
  if (start === coefficient.length)
    return { sign: 0, digits: "", magnitude: { sign: 0, digits: "0" } };
  let end = coefficient.length;
  while (end > start && coefficient[end - 1] === "0") end--;
  const digits = coefficient.slice(start, end);
  return {
    sign: sign === "-" ? -1 : 1,
    digits,
    // Never expand powers of ten: storage follows the input length, even for
    // exponents far beyond JavaScript's finite number range.
    magnitude: addSmallInteger(parseInteger(exponent), integer!.length - start),
  };
}

function compareDecimals(left: Decimal, right: Decimal): number {
  if (left.sign !== right.sign) return left.sign < right.sign ? -1 : 1;
  if (left.sign === 0) return 0;
  const magnitude = compareIntegers(left.magnitude, right.magnitude);
  if (magnitude !== 0) return magnitude * left.sign;
  const length = Math.max(left.digits.length, right.digits.length);
  for (let index = 0; index < length; index++) {
    const a = left.digits[index] ?? "0";
    const b = right.digits[index] ?? "0";
    if (a !== b) return (a < b ? -1 : 1) * left.sign;
  }
  return 0;
}

function parseInteger(value: string): DecimalInteger {
  let start = value[0] === "-" || value[0] === "+" ? 1 : 0;
  while (start < value.length && value[start] === "0") start++;
  return start === value.length
    ? { sign: 0, digits: "0" }
    : { sign: value[0] === "-" ? -1 : 1, digits: value.slice(start) };
}

function compareMagnitudes(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareIntegers(left: DecimalInteger, right: DecimalInteger): number {
  if (left.sign !== right.sign) return left.sign < right.sign ? -1 : 1;
  return compareMagnitudes(left.digits, right.digits) * left.sign;
}

function addSmallInteger(value: DecimalInteger, offset: number): DecimalInteger {
  if (offset === 0) return value;
  const adjustment = parseInteger(String(offset));
  if (value.sign === 0) return adjustment;
  if (value.sign === adjustment.sign) {
    return { sign: value.sign, digits: addDigits(value.digits, adjustment.digits) };
  }
  const order = compareMagnitudes(value.digits, adjustment.digits);
  if (order === 0) return { sign: 0, digits: "0" };
  return order > 0
    ? { sign: value.sign, digits: subtractDigits(value.digits, adjustment.digits) }
    : { sign: adjustment.sign, digits: subtractDigits(adjustment.digits, value.digits) };
}

function digitFromEnd(value: string, offset: number): number {
  const index = value.length - 1 - offset;
  return index < 0 ? 0 : value.charCodeAt(index) - 48;
}

// Exponents can contain arbitrarily many digits. Decimal string arithmetic
// avoids costly conversion of attacker-controlled exponent text to BigInt.
function addDigits(left: string, right: string): string {
  const length = Math.max(left.length, right.length);
  const output = new Uint8Array(length + 1);
  let carry = 0;
  for (let offset = 0; offset < length; offset++) {
    const sum = digitFromEnd(left, offset) + digitFromEnd(right, offset) + carry;
    output[length - offset] = 48 + (sum % 10);
    carry = Math.floor(sum / 10);
  }
  output[0] = 48 + carry;
  return asciiDecoder.decode(output.subarray(carry === 0 ? 1 : 0));
}

function subtractDigits(left: string, right: string): string {
  const output = new Uint8Array(left.length);
  let borrow = 0;
  for (let offset = 0; offset < left.length; offset++) {
    const difference = digitFromEnd(left, offset) - digitFromEnd(right, offset) - borrow;
    output[left.length - 1 - offset] = 48 + (difference < 0 ? difference + 10 : difference);
    borrow = difference < 0 ? 1 : 0;
  }
  let start = 0;
  while (start < output.length - 1 && output[start] === 48) start++;
  return asciiDecoder.decode(output.subarray(start));
}
