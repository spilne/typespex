import { bytesToBase64 } from "@typespex/codec";

export { bytesToBase64 } from "@typespex/codec";

/** Serializes TypeSpec wire values without losing bigint or bytes values. */
export function stringifyJson(value: unknown): string {
  const serialized = serializeJsonValue(value, [], "");
  if (serialized === undefined) {
    throw new TypeError("Value is not JSON serializable.");
  }
  return serialized;
}

function serializeJsonValue(
  value: unknown,
  ancestors: object[] | Set<object>,
  key: string,
): string | undefined {
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

  // Small stacks avoid Set allocations for ordinary shallow JSON. Switch to a
  // Set for deeper graphs so cycle detection stays linear in the graph size.
  if (Array.isArray(ancestors) && ancestors.length === 16) ancestors = new Set(ancestors);
  if (Array.isArray(ancestors)) {
    if (ancestors.includes(value)) throw new TypeError("Converting circular structure to JSON.");
    ancestors.push(value);
  } else {
    if (ancestors.has(value)) throw new TypeError("Converting circular structure to JSON.");
    ancestors.add(value);
  }

  let serialized: string;
  if (Array.isArray(value)) {
    let items = "";
    for (let index = 0; index < value.length; index++) {
      if (index > 0) items += ",";
      items += serializeJsonValue(value[index], ancestors, String(index)) ?? "null";
    }
    serialized = `[${items}]`;
  } else {
    let entries = "";
    for (const property of Object.keys(value)) {
      const item = serializeJsonValue(
        (value as Record<string, unknown>)[property],
        ancestors,
        property,
      );
      if (item !== undefined) {
        if (entries.length > 0) entries += ",";
        entries += `${quoteJsonString(property)}:${item}`;
      }
    }
    serialized = `{${entries}}`;
  }

  if (Array.isArray(ancestors)) ancestors.pop();
  else ancestors.delete(value);
  return serialized;
}

// Native stringification handles escapes and lone surrogates; ordinary strings
// can be quoted directly without entering the native JSON serializer.
function quoteJsonString(value: string): string {
  return /["\\\u0000-\u001f\uD800-\uDFFF]/.test(value) ? JSON.stringify(value) : `"${value}"`;
}
