/** Matched route value plus extracted path parameters for one successful lookup. */
export interface RouteMatch<R> {
  readonly route: R;
  readonly pathParams: Readonly<Record<string, string>>;
}

/** Strategy interface for matching HTTP method/path pairs to route values. */
export interface RouteMatcher<R> {
  match(method: string, pathname: string): RouteMatch<R> | null;
}
