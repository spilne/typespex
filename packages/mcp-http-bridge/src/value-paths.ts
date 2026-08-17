export function getSourceValue(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment))
      return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

export function setTargetValue(
  output: unknown,
  target: string | readonly (string | number)[],
  value: unknown,
): unknown {
  const path = typeof target === "string" ? [target] : target;
  if (path.length === 0) return value;
  let root = output;
  if (
    !isContainer(root) ||
    (typeof path[0] === "number" && isRecord(root) && Object.keys(root).length === 0)
  ) {
    root = typeof path[0] === "number" ? [] : Object.create(null);
  }
  let current = root as Record<PropertyKey, unknown>;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const nextSegment = path[index + 1]!;
    const existing = current[segment];
    if (!isContainer(existing)) {
      current[segment] = typeof nextSegment === "number" ? [] : Object.create(null);
    }
    current = current[segment] as Record<PropertyKey, unknown>;
  }
  current[path.at(-1)!] = value;
  return root;
}

function isContainer(value: unknown): value is Record<PropertyKey, unknown> | unknown[] {
  return Array.isArray(value) || isRecord(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
