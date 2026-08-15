import { bytesToBase64 } from "./base64.js";

const DECIMAL_NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const DECIMAL_INTEGER_PATTERN = /^-?(?:0|[1-9]\d*)$/;
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|([+-])(\d{2}):(\d{2}))$/;
const RFC7231_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const ISO_DURATION_PATTERN =
  /^([+-])?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(T(?:(\d+(?:[.,]\d{1,9})?)H)?(?:(\d+(?:[.,]\d{1,9})?)M)?(?:(\d+(?:[.,]\d{1,9})?)S)?)?$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*={0,2}$/;

export interface NumericWireEncoding {
  readonly bigint?: boolean;
  readonly integer?: boolean;
  readonly min?: number | bigint;
  readonly max?: number | bigint;
}

export type DurationNumericUnit = "seconds" | "milliseconds";

/** Runtime conversions shared by generated request decoders and response serializers. */
export const ScalarEncodings = {
  decodeNumberString,
  decodeIntegerString,
  decodeBigIntString,
  decodeBooleanString,
  encodeNumberString,
  encodeBigIntString,
  encodeBooleanString,
  decodeRfc3339DateTime,
  decodeDateTimeDate,
  encodeRfc3339DateTime,
  decodeRfc7231DateTime,
  encodeRfc7231DateTime,
  decodeUnixTimestamp,
  encodeUnixTimestamp,
  decodeIsoDuration,
  encodeIsoDuration,
  decodeNumericDuration,
  encodeNumericDuration,
  decodeBase64Url,
  encodeBase64,
  encodeBase64Url,
} as const;

function decodeNumberString(value: string): number {
  if (!DECIMAL_NUMBER_PATTERN.test(value)) {
    throw new TypeError("Expected a decimal number string.");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError("Expected a finite number string.");
  return parsed;
}

function decodeIntegerString(value: string): number {
  if (!DECIMAL_INTEGER_PATTERN.test(value)) {
    throw new TypeError("Expected a decimal integer string.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError("Expected a safe integer string.");
  return parsed;
}

function decodeBigIntString(value: string): bigint {
  if (!DECIMAL_INTEGER_PATTERN.test(value)) {
    throw new TypeError("Expected a decimal integer string.");
  }
  if (value[0] === "-" ? value.length - 1 > 20 : value.length > 20) {
    throw new RangeError("Encoded integer string exceeds the supported 64-bit width.");
  }
  return BigInt(value);
}

function decodeBooleanString(value: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new TypeError('Expected a case-insensitive "true" or "false" string.');
}

function encodeNumberString(value: number, options: NumericWireEncoding = {}): string {
  validateNumericWireValue(value, { ...options, bigint: false });
  return String(value);
}

function encodeBigIntString(value: bigint, options: NumericWireEncoding = {}): string {
  validateNumericWireValue(value, { ...options, bigint: true, integer: true });
  return String(value);
}

function encodeBooleanString(value: boolean): string {
  if (typeof value !== "boolean") throw new TypeError("Expected a boolean handler value.");
  return String(value);
}

function decodeRfc3339DateTime(value: string): string {
  validateRfc3339(value, "wire");
  return value;
}

function decodeDateTimeDate(value: string): Date {
  return parseHandlerDateTime(value);
}

function encodeRfc3339DateTime(value: string): string {
  validateRfc3339(value, "handler");
  return value;
}

function decodeRfc7231DateTime(value: string): string {
  if (!RFC7231_PATTERN.test(value)) {
    throw new TypeError("Expected an RFC 7231 IMF-fixdate string.");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toUTCString() !== value) {
    throw new TypeError("Expected a valid RFC 7231 date-time.");
  }
  return date.toISOString();
}

function encodeRfc7231DateTime(value: string): string {
  const date = parseHandlerDateTime(value);
  return date.toUTCString();
}

function decodeUnixTimestamp(value: number | bigint): string {
  if ((typeof value !== "number" || !Number.isSafeInteger(value)) && typeof value !== "bigint") {
    throw new TypeError("Expected an integer Unix timestamp.");
  }
  const milliseconds = Number(value) * 1000;
  const date = new Date(milliseconds);
  if (!Number.isFinite(milliseconds) || !Number.isFinite(date.getTime())) {
    throw new RangeError("Unix timestamp is outside the supported date-time range.");
  }
  return date.toISOString();
}

function encodeUnixTimestamp(
  value: string,
  options: NumericWireEncoding = { integer: true },
): number | bigint {
  const seconds = Math.floor(parseHandlerDateTime(value).getTime() / 1000);
  const encoded = options.bigint ? BigInt(seconds) : seconds;
  validateNumericWireValue(encoded, { ...options, integer: true });
  return encoded;
}

function decodeIsoDuration(value: string): string {
  validateIsoDuration(value, "wire");
  return value;
}

function encodeIsoDuration(value: string): string {
  validateIsoDuration(value, "handler");
  return value;
}

function decodeNumericDuration(value: number | bigint, unit: DurationNumericUnit): string {
  let duration: Rational;
  if (typeof value === "bigint") {
    duration = { numerator: value, scale: 1n };
  } else {
    if (!Number.isFinite(value)) throw new TypeError("Expected a finite duration value.");
    duration = decimalToRational(String(value));
  }
  if (unit === "milliseconds") {
    duration = { numerator: duration.numerator, scale: duration.scale * 1000n };
  }
  return rationalSecondsToIso(duration);
}

function encodeNumericDuration(
  value: string,
  unit: DurationNumericUnit,
  options: NumericWireEncoding = {},
): number | bigint {
  let duration = fixedDurationToSeconds(value);
  if (unit === "milliseconds") {
    duration = { numerator: duration.numerator * 1000n, scale: duration.scale };
  }

  let encoded: number | bigint;
  if (options.integer || options.bigint) {
    const integer = floorRational(duration);
    encoded = options.bigint ? integer : Number(integer);
  } else {
    encoded = Number(duration.numerator) / Number(duration.scale);
  }
  validateNumericWireValue(encoded, options);
  return encoded;
}

function decodeBase64Url(value: string): Uint8Array {
  if (!BASE64URL_PATTERN.test(value)) {
    throw new TypeError("Expected a valid base64url string.");
  }
  const paddingLength = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const unpadded = paddingLength === 0 ? value : value.slice(0, -paddingLength);
  if (unpadded.length % 4 === 1 || (paddingLength > 0 && value.length % 4 !== 0)) {
    throw new TypeError("Expected a valid base64url string.");
  }
  const base64 = unpadded.replace(/-/g, "+").replace(/_/g, "/");
  const normalized = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
  try {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    if (encodeBase64Url(bytes) !== unpadded) {
      throw new TypeError("Expected a canonical base64url string.");
    }
    return bytes;
  } catch {
    throw new TypeError("Expected a valid base64url string.");
  }
}

function encodeBase64(value: Uint8Array): string {
  if (!(value instanceof Uint8Array)) throw new TypeError("Expected a Uint8Array handler value.");
  return bytesToBase64(value);
}

function encodeBase64Url(value: Uint8Array): string {
  return encodeBase64(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function validateRfc3339(value: string, source: "wire" | "handler"): void {
  if (typeof value !== "string" || !RFC3339_PATTERN.test(value)) {
    throw new TypeError(`Expected an RFC 3339 ${source} date-time string.`);
  }
  if (!parseRfc3339(value)) {
    throw new TypeError(`Expected a valid RFC 3339 ${source} date-time.`);
  }
}

function parseHandlerDateTime(value: string): Date {
  validateRfc3339(value, "handler");
  return parseRfc3339(value)!;
}

function parseRfc3339(value: string): Date | undefined {
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return undefined;

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    fraction = "",
    offset,
    offsetSign,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetSign ? Number(offsetHourText) : 0;
  const offsetMinute = offsetSign ? Number(offsetMinuteText) : 0;

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 60 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return undefined;
  }

  const normalizedOffset =
    offset.toUpperCase() === "Z" ? "Z" : `${offsetSign}${offsetHourText}:${offsetMinuteText}`;
  const parseableSecond = Math.min(second, 59).toString().padStart(2, "0");
  const date = new Date(
    `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${parseableSecond}${fraction}${normalizedOffset}`,
  );
  if (!Number.isFinite(date.getTime())) return undefined;
  if (second === 60) date.setTime(date.getTime() + 1000);
  return date;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function validateIsoDuration(value: string, source: "wire" | "handler"): void {
  if (!parseIsoDuration(value)) {
    throw new TypeError(`Expected an ISO 8601 ${source} duration string.`);
  }
}

interface ParsedIsoDuration {
  readonly negative: boolean;
  readonly years?: string;
  readonly months?: string;
  readonly weeks?: string;
  readonly days?: string;
  readonly hours?: string;
  readonly minutes?: string;
  readonly seconds?: string;
}

function parseIsoDuration(value: string): ParsedIsoDuration | undefined {
  if (typeof value !== "string") return undefined;
  const match = ISO_DURATION_PATTERN.exec(value);
  if (!match) return undefined;

  const [, sign, years, months, weeks, days, time, hours, minutes, seconds] = match;
  if ([years, months, weeks, days, hours, minutes, seconds].every((part) => part === undefined)) {
    return undefined;
  }
  if (time && hours === undefined && minutes === undefined && seconds === undefined) {
    return undefined;
  }
  if (
    (hasFraction(hours) && (minutes !== undefined || seconds !== undefined)) ||
    (hasFraction(minutes) && seconds !== undefined)
  ) {
    return undefined;
  }

  return {
    negative: sign === "-",
    years,
    months,
    weeks,
    days,
    hours,
    minutes,
    seconds,
  };
}

function hasFraction(value: string | undefined): boolean {
  return value?.includes(".") === true || value?.includes(",") === true;
}

interface Rational {
  readonly numerator: bigint;
  readonly scale: bigint;
}

function fixedDurationToSeconds(value: string): Rational {
  const duration = parseIsoDuration(value);
  if (!duration || duration.years !== undefined || duration.months !== undefined) {
    throw new TypeError(
      "Numeric duration encodings require an ISO 8601 duration containing only weeks, days, hours, minutes, or seconds.",
    );
  }

  let total: Rational = { numerator: 0n, scale: 1n };
  total = addRational(total, scaledDecimal(duration.weeks, 604800n));
  total = addRational(total, scaledDecimal(duration.days, 86400n));
  total = addRational(total, scaledDecimal(duration.hours, 3600n));
  total = addRational(total, scaledDecimal(duration.minutes, 60n));
  total = addRational(total, scaledDecimal(duration.seconds, 1n));
  return duration.negative ? { numerator: -total.numerator, scale: total.scale } : total;
}

function scaledDecimal(value: string | undefined, multiplier: bigint): Rational {
  if (value === undefined) return { numerator: 0n, scale: 1n };
  const parsed = decimalToRational(value);
  return { numerator: parsed.numerator * multiplier, scale: parsed.scale };
}

function decimalToRational(value: string): Rational {
  const match = /^([+-])?(\d+)(?:[.,](\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) throw new TypeError("Expected a finite decimal value.");
  const [, sign, integer, fraction = "", exponentText = "0"] = match;
  const exponent = Number(exponentText);
  const digits = `${integer}${fraction}`.replace(/^0+(?=\d)/, "");
  let numerator = BigInt(digits || "0");
  let scalePower = fraction.length - exponent;
  if (scalePower < 0) {
    numerator *= 10n ** BigInt(-scalePower);
    scalePower = 0;
  }
  if (sign === "-") numerator = -numerator;
  return { numerator, scale: 10n ** BigInt(scalePower) };
}

function addRational(left: Rational, right: Rational): Rational {
  if (left.scale === right.scale) {
    return { numerator: left.numerator + right.numerator, scale: left.scale };
  }
  const scale = left.scale > right.scale ? left.scale : right.scale;
  return {
    numerator: left.numerator * (scale / left.scale) + right.numerator * (scale / right.scale),
    scale,
  };
}

function floorRational(value: Rational): bigint {
  const quotient = value.numerator / value.scale;
  const remainder = value.numerator % value.scale;
  return value.numerator < 0n && remainder !== 0n ? quotient - 1n : quotient;
}

function rationalSecondsToIso(value: Rational): string {
  if (value.numerator === 0n) return "PT0S";
  const negative = value.numerator < 0n;
  const numerator = negative ? -value.numerator : value.numerator;
  const integer = numerator / value.scale;
  const remainder = numerator % value.scale;
  let decimal = String(integer);
  if (remainder !== 0n) {
    const digits = String(value.scale).length - 1;
    const fraction = String(remainder).padStart(digits, "0").replace(/0+$/, "");
    decimal += `.${fraction}`;
  }
  return `${negative ? "-" : ""}PT${decimal}S`;
}

function validateNumericWireValue(value: number | bigint, options: NumericWireEncoding): void {
  if (options.bigint) {
    if (typeof value !== "bigint") throw new TypeError("Expected a bigint handler value.");
  } else if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Expected a finite number handler value.");
  }

  if (options.integer && typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new TypeError("Expected a safe integer handler value.");
  }
  if (options.min !== undefined && compareNumeric(value, options.min) < 0) {
    throw new RangeError(`Encoded value must be at least ${String(options.min)}.`);
  }
  if (options.max !== undefined && compareNumeric(value, options.max) > 0) {
    throw new RangeError(`Encoded value must be at most ${String(options.max)}.`);
  }
}

function compareNumeric(left: number | bigint, right: number | bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
