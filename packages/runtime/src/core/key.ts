/** A symbol-based typed key for type-safe heterogeneous maps. */
export interface TypedKey<T> {
  readonly symbol: symbol;
  readonly name: string;
  /** Phantom type brand — not set at runtime. */
  readonly __type?: T;
}

/** Creates a unique typed key with the given display name. */
export function createTypedKey<T>(name: string): TypedKey<T> {
  return { symbol: Symbol(name), name } as TypedKey<T>;
}
