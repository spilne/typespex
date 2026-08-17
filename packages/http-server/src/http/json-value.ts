// Lossless JSON parsing shared by regular, JSONL, and multipart bodies.
import { parse as parseLosslessJson } from "lossless-json";
import { defineDataProperty } from "./object-properties.js";

const DECIMAL_INTEGER_PATTERN = /^-?(?:0|[1-9]\d*)$/;
const MAX_LOSSLESS_JSON_INTEGER_DIGITS = 20;

export function parseJsonText(text: string): unknown {
  const nativeValue = JSON.parse(text) as unknown;
  const preciseValue = parseLosslessJson(text, undefined, { parseNumber: parseJsonNumber });
  return rebuildJsonValue(nativeValue, preciseValue);
}

function parseJsonNumber(value: string): number | bigint {
  if (DECIMAL_INTEGER_PATTERN.test(value)) {
    const digitCount = value[0] === "-" ? value.length - 1 : value.length;
    if (digitCount > MAX_LOSSLESS_JSON_INTEGER_DIGITS) {
      throw new SyntaxError(
        `JSON integers may contain at most ${MAX_LOSSLESS_JSON_INTEGER_DIGITS} digits.`,
      );
    }
    const numberValue = Number(value);
    return Number.isSafeInteger(numberValue) ? numberValue : BigInt(value);
  }
  const exactInteger = exactJsonIntegerWithinLimit(value);
  if (exactInteger !== undefined) {
    const numberValue = Number(value);
    return Number.isSafeInteger(numberValue) ? numberValue : BigInt(exactInteger);
  }
  return Number(value);
}

/** Canonicalizes decimal/exponent JSON tokens that are exact bounded integers. */
function exactJsonIntegerWithinLimit(value: string): string | undefined {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) return undefined;

  const sign = match[1] ?? "";
  const integerPart = match[2]!;
  const fractionalPart = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent)) return undefined;

  const combined = `${integerPart}${fractionalPart}`;
  const decimalIndex = integerPart.length + exponent;
  let integerDigits: string;
  let trailingZeros = 0;

  if (decimalIndex <= 0) {
    if (/[^0]/.test(combined)) return undefined;
    integerDigits = "0";
  } else if (decimalIndex < combined.length) {
    if (/[^0]/.test(combined.substring(decimalIndex))) return undefined;
    integerDigits = combined.substring(0, decimalIndex);
  } else {
    integerDigits = combined;
    trailingZeros = decimalIndex - combined.length;
  }

  const significant = integerDigits.replace(/^0+/, "") || "0";
  const digitCount = significant === "0" ? 1 : significant.length + trailingZeros;
  if (digitCount > MAX_LOSSLESS_JSON_INTEGER_DIGITS) return undefined;
  if (significant === "0") return "0";
  return `${sign}${significant}${"0".repeat(trailingZeros)}`;
}

/**
 * Rebuilds from native JSON's safe object shape while taking numeric leaves
 * from the lossless parse. This avoids special keys such as `__proto__`
 * changing object prototypes inside third-party parser output.
 */
function rebuildJsonValue(nativeValue: unknown, preciseValue: unknown): unknown {
  if (typeof nativeValue === "number") return preciseValue;
  if (Array.isArray(nativeValue)) {
    const preciseItems = Array.isArray(preciseValue) ? preciseValue : [];
    return nativeValue.map((item, index) => rebuildJsonValue(item, preciseItems[index]));
  }
  if (typeof nativeValue !== "object" || nativeValue === null) return nativeValue;

  const nativeObject = nativeValue as Record<string, unknown>;
  const preciseObject = preciseValue as Record<string, unknown> | null;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(nativeObject)) {
    const matchingValue =
      preciseObject && Object.prototype.hasOwnProperty.call(preciseObject, key)
        ? preciseObject[key]
        : nativeObject[key];
    defineDataProperty(result, key, rebuildJsonValue(nativeObject[key], matchingValue));
  }
  return result;
}
