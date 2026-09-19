import { bytesToBase64 } from "@typespex/codec";
import { defineDataProperty } from "./object-properties.js";

export { bytesToBase64 } from "@typespex/codec";

const NEEDS_JSON_ESCAPE = /["\\\u0000-\u001f\uD800-\uDFFF]/;

interface JsonPreparation {
  requiresDirectWriter: boolean;
}

// A private marker keeps pre-encoded object text distinct from user strings.
class EncodedJsonValue {
  constructor(readonly text: string) {}
}

/** Serializes TypeSpec wire values without losing bigint or bytes values. */
export function stringifyJson(value: unknown): string {
  const preparation: JsonPreparation = { requiresDirectWriter: false };
  // Native JSON produces a flat string from this snapshot. Preparing it first
  // preserves TypeSpec encodings without a second traversal of user values.
  const prepared = prepareJsonValue(value, [], "", preparation);
  // Input getters may install a prototype hook while values are being prepared.
  // The fallback writes the snapshot directly so no hook is invoked twice.
  // Snapshot arrays already have null prototypes, so only object hooks remain.
  const serialized = stringifyPreparedJson(prepared, preparation);
  if (serialized === undefined) throw new TypeError("Value is not JSON serializable.");
  return serialized;
}

function prepareJsonValue(
  value: unknown,
  ancestors: object[] | Set<object>,
  key: string | number,
  preparation: JsonPreparation,
): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "bigint":
      preparation.requiresDirectWriter = true;
      return value;
    case "function":
    case "symbol":
      return undefined;
    case "object":
      break;
    default:
      return value;
  }

  if (value instanceof Uint8Array) return bytesToBase64(value);
  if (value instanceof Number || value instanceof String || value instanceof Boolean) {
    return prepareJsonValue(value.valueOf(), ancestors, key, preparation);
  }

  const toJSON = (value as { toJSON?: (key: string) => unknown }).toJSON;
  if (typeof toJSON === "function") {
    // Array indices only need text when passed to a custom serialization hook.
    const replacement = toJSON.call(value, typeof key === "number" ? String(key) : key);
    if (replacement !== value) return prepareJsonValue(replacement, ancestors, key, preparation);
  }

  // Shallow graphs avoid Set allocation; deeper graphs retain linear cycle checks.
  if (Array.isArray(ancestors) && ancestors.length === 16) ancestors = new Set(ancestors);
  if (Array.isArray(ancestors)) {
    if (ancestors.includes(value)) throw new TypeError("Converting circular structure to JSON.");
    ancestors.push(value);
  } else {
    if (ancestors.has(value)) throw new TypeError("Converting circular structure to JSON.");
    ancestors.add(value);
  }

  let output: unknown;
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    // Snapshots must not inherit another toJSON hook or indexed setter.
    Object.setPrototypeOf(items, null);
    for (let index = 0; index < value.length; index++) {
      items[index] = prepareJsonValue(value[index], ancestors, index, preparation);
    }
    output = items;
  } else {
    const properties = Object.keys(value);
    if (properties.some(startsWithDigit)) {
      // Numeric-keyed objects are slow in native JSON on Bun. Writing their
      // keys directly also preserves a Proxy's nonstandard enumeration order.
      output = prepareEncodedObject(value, properties, ancestors, preparation);
      preparation.requiresDirectWriter = true;
    } else {
      const object: Record<string, unknown> = {};
      for (const property of properties) {
        defineDataProperty(
          object,
          property,
          prepareJsonValue(
            (value as Record<string, unknown>)[property],
            ancestors,
            property,
            preparation,
          ),
        );
      }
      output = object;
    }
  }

  if (Array.isArray(ancestors)) ancestors.pop();
  else ancestors.delete(value);
  return output;
}

function startsWithDigit(value: string): boolean {
  const first = value.charCodeAt(0);
  return first >= 48 && first <= 57;
}

// Prepared values contain only primitives and own data properties. Their hooks
// and cycles have already been handled, and bigint needs an unquoted token.
function stringifyPreparedValue(value: unknown): string | undefined {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return quoteJsonString(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return Number.isFinite(value) ? String(value) : "null";
    case "bigint":
      return String(value);
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
  }
  if (value instanceof EncodedJsonValue) return value.text;
  if (Array.isArray(value)) {
    let items = "";
    for (let index = 0; index < value.length; index++) {
      if (index > 0) items += ",";
      items += stringifyPreparedValue(value[index]) ?? "null";
    }
    return `[${items}]`;
  }
  let entries = "";
  for (const property of Object.keys(value)) {
    const item = stringifyPreparedValue((value as Record<string, unknown>)[property]);
    if (item !== undefined) {
      if (entries.length > 0) entries += ",";
      entries += `${quoteJsonString(property)}:${item}`;
    }
  }
  return `{${entries}}`;
}

function quoteJsonString(value: string): string {
  return NEEDS_JSON_ESCAPE.test(value) ? JSON.stringify(value) : `"${value}"`;
}

function stringifyPreparedJson(value: unknown, preparation: JsonPreparation): string | undefined {
  return preparation.requiresDirectWriter || Object.hasOwn(Object.prototype, "toJSON")
    ? stringifyPreparedValue(value)
    : JSON.stringify(value);
}

function prepareEncodedObject(
  value: object,
  properties: readonly string[],
  ancestors: object[] | Set<object>,
  preparation: JsonPreparation,
): EncodedJsonValue {
  let entries = "";
  for (const property of properties) {
    const member = (value as Record<string, unknown>)[property];
    const item =
      member === null || typeof member !== "object"
        ? stringifyPreparedValue(member)
        : stringifyPreparedJson(
            prepareJsonValue(member, ancestors, property, preparation),
            preparation,
          );
    if (item !== undefined) {
      if (entries.length > 0) entries += ",";
      entries += `${quoteJsonString(property)}:${item}`;
    }
  }
  return new EncodedJsonValue(`{${entries}}`);
}
