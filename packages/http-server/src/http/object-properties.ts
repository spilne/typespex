/** Defines an own enumerable property without invoking prototype setters. */
export function defineDataProperty(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

/** Appends a repeated HTTP field while preserving prototype-sensitive names. */
export function appendBodyField(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (!Object.prototype.hasOwnProperty.call(target, key)) {
    defineDataProperty(target, key, value);
    return;
  }

  const existing = target[key];
  if (Array.isArray(existing)) existing.push(value);
  else defineDataProperty(target, key, [existing, value]);
}
