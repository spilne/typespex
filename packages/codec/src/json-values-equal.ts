/** Compare JSON-shaped values without depending on object key order. */
export function jsonValuesEqual(
  left: unknown,
  right: unknown,
  seen: WeakMap<object, WeakSet<object>> = new WeakMap(),
): boolean {
  if (Object.is(left, right) || (typeof left === "number" && left === right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object")
    return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    if (left.length !== (right as unknown[]).length) return false;
  } else if (!isPlainObject(left) || !isPlainObject(right)) {
    return false;
  }
  const paired = seen.get(left) ?? new WeakSet<object>();
  if (paired.has(right)) return true;
  paired.add(right);
  seen.set(left, paired);
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(
    (key) =>
      Object.hasOwn(right, key) &&
      jsonValuesEqual(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        seen,
      ),
  );
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Compare decoded values while retaining distinctions between semantic representations. */
export async function semanticValuesEqual(
  left: unknown,
  right: unknown,
  opaqueEquals: (left: object, right: object) => Promise<boolean>,
  seen: WeakMap<object, WeakSet<object>> = new WeakMap(),
): Promise<boolean> {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object")
    return false;
  if (left instanceof Date || right instanceof Date) {
    return (
      left instanceof Date && right instanceof Date && Object.is(left.getTime(), right.getTime())
    );
  }
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    return (
      left instanceof Uint8Array &&
      right instanceof Uint8Array &&
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }
  if (typeof File !== "undefined" && (left instanceof File || right instanceof File)) {
    if (
      !(left instanceof File && right instanceof File) ||
      left.name !== right.name ||
      left.type !== right.type ||
      left.size !== right.size
    )
      return false;
    // Last-modified timestamps are not part of the file wire contract.
    return semanticValuesEqual(
      new Uint8Array(await left.arrayBuffer()),
      new Uint8Array(await right.arrayBuffer()),
      opaqueEquals,
      seen,
    );
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    if (left.length !== (right as unknown[]).length) return false;
  } else if (!isPlainObject(left) || !isPlainObject(right)) {
    return opaqueEquals(left, right);
  }
  const paired = seen.get(left) ?? new WeakSet<object>();
  if (paired.has(right)) return true;
  paired.add(right);
  seen.set(left, paired);
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    if (
      !Object.hasOwn(right, key) ||
      !(await semanticValuesEqual(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        opaqueEquals,
        seen,
      ))
    )
      return false;
  }
  return true;
}
