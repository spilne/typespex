// Lossless JSON parsing shared by regular, JSONL, and multipart bodies.
import { parse as parseLosslessJson } from "lossless-json";
import { defineDataProperty } from "./object-properties.js";

const JSON_NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const DECIMAL_INTEGER_PATTERN = /^-?(?:0|[1-9]\d*)$/;
const MAX_LOSSLESS_JSON_INTEGER_DIGITS = 20;
// Avoid failed native round trips for noncanonical single-line formatting.
const NATIVE_JSON_FALLBACK_PATTERN = /\d{16}|[\r\n\t]|[,:] /;
const LARGE_JSON_INTEGER_PATTERN = /\d{16}/;

export function parseJsonText(text: string): unknown {
  const noncanonical = NATIVE_JSON_FALLBACK_PATTERN.test(text);
  const multiline = noncanonical && text.includes("\n");
  // Native parsing is lossless when small-number JSON survives a round trip,
  // allowing multiline whitespace only outside strings. The comparison also
  // rules out duplicate keys and negative-zero changes.
  // Large integer tokens retain the parser's bigint and digit-limit semantics.
  if (
    (!noncanonical || (multiline && !LARGE_JSON_INTEGER_PATTERN.test(text))) &&
    !("toJSON" in Object.prototype) &&
    !("toJSON" in Array.prototype)
  ) {
    const value = JSON.parse(text);
    try {
      const serialized = JSON.stringify(value);
      if (serialized === text || (multiline && matchesJsonWhitespace(serialized, text))) {
        return value;
      }
    } catch {
      // A native serialization depth limit must not change parsing support.
    }
  }

  const preciseValue = parseLosslessJson(text, undefined, { parseNumber: parseJsonNumber });
  // Only a literal or Unicode-escaped __proto__ key can invoke the prototype
  // setter in the lossless parser. Keep native JSON's safe object shape for
  // those inputs; ordinary payloads need neither a second parse nor a copy.
  if (!text.includes("__proto__") && !text.includes("\\u")) return preciseValue;
  return rebuildJsonValue(JSON.parse(text), preciseValue);
}

/** Compares JSON spellings while ignoring only whitespace outside strings. */
function matchesJsonWhitespace(serialized: string, text: string): boolean {
  let cursor = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < serialized.length; index++) {
    const expected = serialized.charCodeAt(index);
    if (!inString) {
      while (isJsonWhitespace(text.charCodeAt(cursor))) cursor++;
    }
    if (text.charCodeAt(cursor++) !== expected) return false;
    if (inString) {
      if (escaped) escaped = false;
      else if (expected === 92) escaped = true;
      else if (expected === 34) inString = false;
    } else if (expected === 34) inString = true;
  }
  while (isJsonWhitespace(text.charCodeAt(cursor))) cursor++;
  return cursor === text.length;
}

function isJsonWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
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
  // The lossless parser also accepts .5 and e5, so numeric tokens need an
  // explicit JSON grammar check when native JSON's validation pass is skipped.
  if (!JSON_NUMBER_PATTERN.test(value)) throw new SyntaxError("Invalid JSON number.");
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
