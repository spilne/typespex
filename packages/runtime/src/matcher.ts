/** One literal or captured-parameter token in a structured route. */
export type RoutePatternToken =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "parameter"; readonly name: string }
  /** A required terminal parameter that captures one or more complete path segments. */
  | { readonly kind: "rest"; readonly name: string };

/** Tokens composing one slash-delimited route segment. */
export type RoutePatternSegment = readonly RoutePatternToken[];

/**
 * Structured route pattern used when parameters occupy only part of a segment.
 *
 * `segments` excludes slash separators. A `rest` token must be the sole token
 * in the final segment. `trailingSlash` records the exact terminal slash,
 * including `true` for the root path.
 */
export interface RoutePattern {
  readonly segments: readonly RoutePatternSegment[];
  readonly trailingSlash: boolean;
}

/** One required request-header constraint used to distinguish a shared route. */
export interface RouteHeaderConstraint {
  /** Header names are matched case-insensitively. */
  readonly name: string;
  /** Accepted wire values. Every value must be non-empty. */
  readonly values: readonly string[];
  /** Media types ignore case and parameters and support subtype wildcards. */
  readonly kind?: "exact" | "media-type";
}

/** Explicit request metadata that selects one operation among a shared route. */
export interface RouteSelection {
  /** All header constraints must match the request. */
  readonly headers: readonly RouteHeaderConstraint[];
}

/** Route registration accepted by the built-in matchers. */
export interface RouteMatcherInput<R> {
  readonly method: string;
  /** Human-readable route and legacy whole-segment-colon fallback. */
  readonly path: string;
  /** Structured matcher input. Preferred whenever available. */
  readonly routePattern?: RoutePattern;
  /** Required request metadata used only to distinguish duplicate route patterns. */
  readonly selection?: RouteSelection;
  /** Optional human-readable identity included in conflict diagnostics. */
  readonly label?: string;
  readonly route: R;
}

/** Matched route value plus extracted path parameters for one successful lookup. */
export interface RouteMatch<R> {
  readonly route: R;
  readonly pathParams: Readonly<Record<string, string>>;
}

/** Strategy interface for matching HTTP method/path pairs to route values. */
export interface RouteMatcher<R> {
  match(method: string, pathname: string, headers?: Headers): RouteMatch<R> | null;
}
