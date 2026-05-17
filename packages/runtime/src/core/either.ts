/** Minimal FP either used by decoders and handlers. */
export type Either<E, A> =
  | { readonly _tag: "Left"; readonly left: E }
  | { readonly _tag: "Right"; readonly right: A };

/** Constructors and combinators for `Either`. */
export const Either = {

  left<E>(left: E): Either<E, never> {
    return { _tag: "Left", left };
  },

  right<A>(right: A): Either<never, A> {
    return { _tag: "Right", right };
  },

  map<E, A, B>(
    either: Either<E, A>,
    f: (value: A) => B,
  ): Either<E, B> {
    return either._tag === "Right" ? { _tag: "Right", right: f(either.right) } : either;
  },

  flatMap<E, A, E2, B>(
    either: Either<E, A>,
    f: (value: A) => Either<E2, B>,
  ): Either<E | E2, B> {
    return either._tag === "Right" ? f(either.right) : either;
  },

  getOrElse<E, A>(
    either: Either<E, A>,
    fallback: A,
  ): A {
    if (either._tag === "Right") {
      return either.right;
    }
    return fallback;
  },

  getOrElseEval<E, A>(
    either: Either<E, A>,
    fallback: () => A,
  ): A {
    if (either._tag === "Right") {
      return either.right;
    }
    return fallback();
  },

  getOrElseThrow<E extends Error, A>(
    either: Either<E, A>
  ): A {
    if (either._tag === "Right") {
      return either.right;
    }
    throw either.left;
  },

  /** Pattern-match both branches of an `Either`. */
  fold<E, A, B>(
    either: Either<E, A>,
    onLeft: (e: E) => B,
    onRight: (a: A) => B,
  ): B {
    return either._tag === "Right" ? onRight(either.right) : onLeft(either.left);
  },

  /** Transform the left (error) side of an `Either`. */
  mapLeft<E, A, E2>(
    either: Either<E, A>,
    f: (e: E) => E2,
  ): Either<E2, A> {
    return either._tag === "Left" ? { _tag: "Left", left: f(either.left) } : either;
  },

  /** Try an alternative when the `Either` is a `Left`. */
  orElse<E, A, E2>(
    either: Either<E, A>,
    f: () => Either<E2, A>,
  ): Either<E | E2, A> {
    return either._tag === "Right" ? either : f();
  },

};

/** Narrows an `Either` to its left branch. */
export function isLeft<E, A>(
  either: Either<E, A>,
): either is { readonly _tag: "Left"; readonly left: E } {
  return either._tag === "Left";
}

/** Narrows an `Either` to its right branch. */
export function isRight<E, A>(
  either: Either<E, A>,
): either is { readonly _tag: "Right"; readonly right: A } {
  return either._tag === "Right";
}

/** Marks unreachable code where no value can exist. Throws if ever reached at runtime. */
export function absurd(value: never): never {
  throw new Error(`absurd: unexpected value ${JSON.stringify(value)}`);
}
