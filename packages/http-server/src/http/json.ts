import { bytesToBase64 } from "@typespex/codec";

export { bytesToBase64 } from "@typespex/codec";

const NEEDS_JSON_ESCAPE = /["\\\u0000-\u001f\uD800-\uDFFF]/;

interface JsonPreparation {
  hasBigInt: boolean;
  propertyOrders: WeakMap<object, readonly string[]> | undefined;
}

/** Serializes TypeSpec wire values without losing bigint or bytes values. */
export function stringifyJson(value: unknown): string {
  const preparation: JsonPreparation = { hasBigInt: false, propertyOrders: undefined };
  // Native JSON produces a flat string from this snapshot. Preparing it first
  // preserves TypeSpec encodings and reads input getters and hooks only once.
  const prepared = prepareJsonValue(value, [], "", preparation);
  // Input getters may install a prototype hook while values are being prepared.
  // The fallback writes the snapshot directly so no hook is invoked twice.
  const serialized =
    preparation.hasBigInt || preparation.propertyOrders || Object.hasOwn(Object.prototype, "toJSON")
      ? stringifyPreparedValue(prepared, preparation.propertyOrders)
      : JSON.stringify(prepared);
  if (serialized === undefined) throw new TypeError("Value is not JSON serializable.");
  return serialized;
}

function prepareJsonValue(
  value: unknown,
  ancestors: object[] | Set<object>,
  key: string,
  preparation: JsonPreparation,
): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "bigint":
      preparation.hasBigInt = true;
      return value;
    case "function":
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
    const replacement = toJSON.call(value, key);
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
      items[items.length] = prepareJsonValue(value[index], ancestors, String(index), preparation);
    }
    output = items;
  } else {
    const object: Record<string, unknown> = {};
    const properties = Object.keys(value);
    for (const property of properties) {
      const item = prepareJsonValue(
        (value as Record<string, unknown>)[property],
        ancestors,
        property,
        preparation,
      );
      if (property in Object.prototype) {
        Object.defineProperty(object, property, {
          value: item,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      } else object[property] = item;
    }
    // A Proxy can enumerate integer keys out of the normal object order. Keep
    // that order when copying to an ordinary object would rearrange the keys.
    if (properties.some(startsWithDigit)) {
      const preparedKeys = Object.keys(object);
      if (properties.some((property, index) => property !== preparedKeys[index])) {
        preparation.propertyOrders ??= new WeakMap();
        preparation.propertyOrders.set(object, properties);
      }
    }
    output = object;
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
function stringifyPreparedValue(
  value: unknown,
  propertyOrders?: WeakMap<object, readonly string[]>,
): string | undefined {
  if (typeof value === "bigint") return String(value);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    let items = "";
    for (let index = 0; index < value.length; index++) {
      if (index > 0) items += ",";
      items += stringifyPreparedValue(value[index], propertyOrders) ?? "null";
    }
    return `[${items}]`;
  }
  let entries = "";
  for (const property of propertyOrders?.get(value) ?? Object.keys(value)) {
    const item = stringifyPreparedValue(
      (value as Record<string, unknown>)[property],
      propertyOrders,
    );
    if (item !== undefined) {
      if (entries.length > 0) entries += ",";
      const quoted = NEEDS_JSON_ESCAPE.test(property) ? JSON.stringify(property) : `"${property}"`;
      entries += `${quoted}:${item}`;
    }
  }
  return `{${entries}}`;
}
