/** One literal or captured-parameter token inside a path segment. */
export type RoutePatternToken =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "parameter"; readonly name: string };

/** Tokens composing one slash-delimited route segment. */
export type RoutePatternSegment = readonly RoutePatternToken[];

/**
 * Structured route pattern used when parameters occupy only part of a segment.
 *
 * `segments` excludes slash separators. `trailingSlash` records the exact
 * terminal slash, including `true` for the root path.
 */
export interface RoutePattern {
  readonly segments: readonly RoutePatternSegment[];
  readonly trailingSlash: boolean;
}

/** Route registration accepted by the built-in matchers. */
export interface RouteMatcherInput<R> {
  readonly method: string;
  /** Human-readable route and legacy whole-segment-colon fallback. */
  readonly path: string;
  /** Structured matcher input. Preferred whenever available. */
  readonly routePattern?: RoutePattern;
  readonly route: R;
}

/** Matched route value plus extracted path parameters for one successful lookup. */
export interface RouteMatch<R> {
  readonly route: R;
  readonly pathParams: Readonly<Record<string, string>>;
}

/** Strategy interface for matching HTTP method/path pairs to route values. */
export interface RouteMatcher<R> {
  match(method: string, pathname: string): RouteMatch<R> | null;
}
