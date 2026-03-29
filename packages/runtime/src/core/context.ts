import { type TypedKey, createTypedKey } from "./key.js";

/** Typed key for request-scoped values stored in a `ContextMap`. */
export type ContextKey<T> = TypedKey<T>;

/** Creates a unique typed key for values stored in a `ContextMap`. */
export const createContextKey: <T>(name: string) => ContextKey<T> = createTypedKey;

/** Mutable request-scoped storage shared across middleware and handlers. */
export interface ContextMap {
  get<T>(key: ContextKey<T>): T | undefined;
  set<T>(key: ContextKey<T>, value: T): void;
}

/** Minimal request context required by the core runtime layer. */
export interface BaseRequestContext {
  readonly request: Request;
  readonly state: ContextMap;
}

class MutableContextMap implements ContextMap {
  #data: Map<symbol, unknown> | null = null;

  get<T>(key: ContextKey<T>): T | undefined {
    return this.#data?.get(key.symbol) as T | undefined;
  }

  set<T>(key: ContextKey<T>, value: T): void {
    (this.#data ??= new Map()).set(key.symbol, value);
  }
}

/** Creates an empty request-scoped context map. Map allocated lazily on first set. */
export function createContextMap(): ContextMap {
  return new MutableContextMap();
}
