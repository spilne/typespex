import { type TypedKey, createTypedKey } from "./key.js";

/** Typed key for immutable metadata attached to services, namespaces, and operations. */
export type HintKey<T> = TypedKey<T>;

/** Creates a stable typed key for metadata values. */
export const createHintKey: <T>(name: string) => HintKey<T> = createTypedKey;

/** Immutable typed metadata attached to services, namespaces, and operations. */
export interface Hints {
  get<T>(key: HintKey<T>): T | undefined;
  has(key: HintKey<unknown>): boolean;
  entries(): Iterable<readonly [HintKey<unknown>, unknown]>;
}

class HintMap implements Hints {
  readonly #data: Map<symbol, { key: HintKey<unknown>; value: unknown }>;

  constructor(entries?: Iterable<readonly [HintKey<unknown>, unknown]>) {
    this.#data = new Map();
    if (entries) {
      for (const [key, value] of entries) {
        this.#data.set(key.symbol, { key, value });
      }
    }
  }

  get<T>(key: HintKey<T>): T | undefined {
    return this.#data.get(key.symbol)?.value as T | undefined;
  }

  has(key: HintKey<unknown>): boolean {
    return this.#data.has(key.symbol);
  }

  *entries(): Iterable<readonly [HintKey<unknown>, unknown]> {
    for (const entry of this.#data.values()) {
      yield [entry.key, entry.value];
    }
  }
}

/** Creates a `Hints` instance from typed key/value pairs. */
export function createHints(
  entries?: Iterable<readonly [HintKey<unknown>, unknown]>,
): Hints {
  return new HintMap(entries);
}

const EMPTY_HINTS: Hints = new HintMap();

/** Returns the shared empty immutable metadata collection. */
export function emptyHints(): Hints {
  return EMPTY_HINTS;
}
