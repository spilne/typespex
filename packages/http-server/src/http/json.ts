import { bytesToBase64 } from "@typespex/codec";

export { bytesToBase64 } from "@typespex/codec";

/** Serializes TypeSpec wire values without losing bigint or bytes values. */
export function stringifyJson(value: unknown): string {
  const serialized = serializeJsonValue(value, new Set(), "");
  if (serialized === undefined) {
    throw new TypeError("Value is not JSON serializable.");
  }
  return serialized;
}

function serializeJsonValue(
  value: unknown,
  ancestors: Set<object>,
  key: string,
): string | undefined {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
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

  if (value instanceof Uint8Array) {
    return JSON.stringify(bytesToBase64(value));
  }

  if (value instanceof Number || value instanceof String || value instanceof Boolean) {
    return serializeJsonValue(value.valueOf(), ancestors, key);
  }

  const toJSON = (value as { toJSON?: (key: string) => unknown }).toJSON;
  if (typeof toJSON === "function") {
    const replacement = toJSON.call(value, key);
    if (replacement !== value) {
      return serializeJsonValue(replacement, ancestors, key);
    }
  }

  if (ancestors.has(value)) {
    throw new TypeError("Converting circular structure to JSON.");
  }
  ancestors.add(value);

  let serialized: string;
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index++) {
      items.push(serializeJsonValue(value[index], ancestors, String(index)) ?? "null");
    }
    serialized = `[${items.join(",")}]`;
  } else {
    const entries: string[] = [];
    for (const property of Object.keys(value)) {
      const item = serializeJsonValue(
        (value as Record<string, unknown>)[property],
        ancestors,
        property,
      );
      if (item !== undefined) {
        entries.push(`${JSON.stringify(property)}:${item}`);
      }
    }
    serialized = `{${entries.join(",")}}`;
  }

  ancestors.delete(value);
  return serialized;
}
