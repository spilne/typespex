/**
 * Single-regex matcher — one compiled regex per HTTP method.
 * All routes compile into one alternative set; one native exec() call matches
 * and extracts whole-segment or embedded path parameters.
 */

import type {
  RouteMatch,
  RouteMatcher,
  RouteMatcherInput,
  RoutePatternSegment,
} from "./matcher.js";
import {
  type NormalizedRouteInput,
  normalizeRouteInputs,
  type RouteSegmentKind,
  selectRouteVariant,
} from "./match-common.js";
import { canonicalizePathname, rawPathSlice } from "./match-path.js";

const EMPTY_PARAMS: Record<string, string> = Object.freeze(Object.create(null));

interface RouteGroupInfo<R> {
  readonly routes: readonly NormalizedRouteInput<R>[];
  readonly firstGroup: number;
}

interface CompiledMethodRouter<R> {
  readonly regex: RegExp;
  /** Sparse: groupIndex → route metadata, set only at each route's first group. */
  readonly groupToRoute: Array<RouteGroupInfo<R> | undefined>;
}

const SEGMENT_RANK: Readonly<Record<RouteSegmentKind, number>> = {
  static: 0,
  mixed: 1,
  parameter: 2,
  rest: 3,
};

function compareSpecificity<R>(
  left: NormalizedRouteInput<R>,
  right: NormalizedRouteInput<R>,
): number {
  const length = Math.min(left.segmentKinds.length, right.segmentKinds.length);
  for (let index = 0; index < length; index++) {
    const rankDifference =
      SEGMENT_RANK[left.segmentKinds[index]!] - SEGMENT_RANK[right.segmentKinds[index]!];
    if (rankDifference !== 0) return rankDifference;
  }
  if (left.segmentKinds.length !== right.segmentKinds.length) {
    return left.segmentKinds.length - right.segmentKinds.length;
  }
  return left.structure < right.structure ? -1 : left.structure > right.structure ? 1 : 0;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileSegment(segment: RoutePatternSegment): {
  readonly source: string;
  readonly parameterNames: readonly string[];
} {
  const first = segment[0]!;
  if (first.kind === "rest") {
    return { source: "([^\\/]+(?:\\/[^\\/]+)*)", parameterNames: [first.name] };
  }

  let source = "";
  const parameterNames: string[] = [];
  const parameterPattern = segment.length === 1 ? "([^\\/]+?)" : "([^\\/]*?)";
  for (const token of segment) {
    if (token.kind === "literal") {
      source += escapeRegex(token.value);
    } else {
      source += parameterPattern;
      parameterNames.push(token.name);
    }
  }
  return { source, parameterNames };
}

function compileMethodRoutes<R>(
  routes: ReadonlyArray<NormalizedRouteInput<R>>,
): CompiledMethodRouter<R> {
  const alternatives: string[] = [];
  const groupToRoute: Array<RouteGroupInfo<R> | undefined> = [];
  let nextGroup = 1;

  for (let routeIndex = 0; routeIndex < routes.length;) {
    const firstRoute = routes[routeIndex]!;
    const variants = [firstRoute];
    routeIndex += 1;
    while (routeIndex < routes.length && routes[routeIndex]!.structure === firstRoute.structure) {
      variants.push(routes[routeIndex]!);
      routeIndex += 1;
    }

    const { pattern } = firstRoute;
    const paramNames: string[] = [];
    const firstGroup = nextGroup;
    let source = pattern.segments.length === 0 ? "\\/" : "";

    for (const segment of pattern.segments) {
      const compiled = compileSegment(segment);
      source += `\\/${compiled.source}`;
      paramNames.push(...compiled.parameterNames);
      nextGroup += compiled.parameterNames.length;
    }
    if (pattern.segments.length > 0 && pattern.trailingSlash) source += "\\/";

    // A marker group identifies static alternatives in the combined regex.
    if (paramNames.length === 0) {
      source = `(${source})`;
      nextGroup += 1;
    }

    alternatives.push(source);
    groupToRoute[firstGroup] = { routes: variants, firstGroup };
  }

  return {
    regex: new RegExp(`^(?:${alternatives.join("|")})$`, "du"),
    groupToRoute,
  };
}

function regexLookup<R>(
  compiled: CompiledMethodRouter<R>,
  pathname: string,
  headers?: Headers,
): RouteMatch<R> | null {
  const canonical = canonicalizePathname(pathname);
  if (!canonical) return null;
  const match = compiled.regex.exec(canonical.value);
  if (!match) return null;

  for (let index = 1; index < match.length; index++) {
    if (match[index] === undefined) continue;
    const info = compiled.groupToRoute[index];
    if (!info) continue;
    const selected = selectRouteVariant(info.routes, headers);
    if (!selected) return null;

    if (selected.parameterNames.length === 0) {
      return { route: selected.route, pathParams: EMPTY_PARAMS };
    }
    const pathParams: Record<string, string> = Object.create(null);
    const indices = match.indices!;
    for (let parameter = 0; parameter < selected.parameterNames.length; parameter++) {
      const range = indices[info.firstGroup + parameter]!;
      pathParams[selected.parameterNames[parameter]!] = rawPathSlice(canonical, range[0], range[1]);
    }
    return { route: selected.route, pathParams };
  }
  return null;
}

export function createRegexMatcher<R>(
  routes: ReadonlyArray<RouteMatcherInput<R>>,
): RouteMatcher<R> {
  const perMethod = new Map<string, NormalizedRouteInput<R>[]>();
  for (const route of normalizeRouteInputs(routes)) {
    const group = perMethod.get(route.method);
    if (group) group.push(route);
    else perMethod.set(route.method, [route]);
  }

  const compiled = new Map<string, CompiledMethodRouter<R>>();
  for (const [method, group] of perMethod) {
    compiled.set(method, compileMethodRoutes(group.sort(compareSpecificity)));
  }

  return {
    match(method, pathname, headers) {
      const router = compiled.get(method);
      return router ? regexLookup(router, pathname, headers) : null;
    },
  };
}
