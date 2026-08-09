/**
 * Segment radix matcher — one precedence-aware tree per HTTP method.
 *
 * Each node checks exact static segments, then embedded-parameter mixed
 * segments, then a whole-segment parameter. Branches of equal rank backtrack
 * so later-segment specificity remains deterministic.
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
  routePatternSegmentKind,
  selectRouteVariant,
} from "./match-common.js";
import { type CanonicalPathSegment, canonicalizePathname, rawSegmentSlice } from "./match-path.js";

const EMPTY_PARAMS: Record<string, string> = Object.freeze(Object.create(null));

interface StoredRoute<R> {
  readonly variants: readonly NormalizedRouteInput<R>[];
}

interface MixedEdge<R> {
  readonly matcher: RegExp;
  readonly child: RadixNode<R>;
}

interface RadixNode<R> {
  readonly staticChildren: Map<string, RadixNode<R>>;
  readonly mixedChildren: Map<string, MixedEdge<R>>;
  param?: RadixNode<R>;
  readonly routes: Map<boolean, StoredRoute<R>>;
}

interface RankedMatch<R> {
  /** `null` means the best path matched but none of its shared-route selectors did. */
  readonly match: RouteMatch<R> | null;
  readonly ranks: readonly number[];
}

function createNode<R>(): RadixNode<R> {
  return {
    staticChildren: new Map(),
    mixedChildren: new Map(),
    routes: new Map(),
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mixedSegmentKey(segment: RoutePatternSegment): string {
  return JSON.stringify(
    segment.map((token) => (token.kind === "literal" ? ["literal", token.value] : ["parameter"])),
  );
}

function compileMixedSegment(segment: RoutePatternSegment): RegExp {
  let source = "";
  for (const token of segment) {
    source += token.kind === "literal" ? escapeRegex(token.value) : "([^\\/]*?)";
  }
  return new RegExp(`^${source}$`, "du");
}

function insertRoute<R>(root: RadixNode<R>, input: NormalizedRouteInput<R>): void {
  let node = root;
  for (const segment of input.pattern.segments) {
    const kind = routePatternSegmentKind(segment);
    if (kind === "static") {
      const literal = segment[0]!;
      const value = literal.kind === "literal" ? literal.value : "";
      let child = node.staticChildren.get(value);
      if (!child) {
        child = createNode();
        node.staticChildren.set(value, child);
      }
      node = child;
    } else if (kind === "parameter") {
      node.param ??= createNode();
      node = node.param;
    } else {
      const key = mixedSegmentKey(segment);
      let edge = node.mixedChildren.get(key);
      if (!edge) {
        edge = { matcher: compileMixedSegment(segment), child: createNode() };
        node.mixedChildren.set(key, edge);
      }
      node = edge.child;
    }
  }
  const stored = node.routes.get(input.pattern.trailingSlash);
  node.routes.set(input.pattern.trailingSlash, {
    variants: stored ? [...stored.variants, input] : [input],
  });
}

function finishMatch<R>(
  stored: StoredRoute<R>,
  captured: readonly string[],
  headers?: Headers,
): RouteMatch<R> | null {
  const selected = selectRouteVariant(stored.variants, headers);
  if (!selected) return null;
  if (selected.parameterNames.length === 0) {
    return { route: selected.route, pathParams: EMPTY_PARAMS };
  }
  const pathParams: Record<string, string> = Object.create(null);
  for (let index = 0; index < selected.parameterNames.length; index++) {
    pathParams[selected.parameterNames[index]!] = captured[index]!;
  }
  return { route: selected.route, pathParams };
}

function compareRanks(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return left.length - right.length;
}

function search<R>(
  node: RadixNode<R>,
  segments: readonly CanonicalPathSegment[],
  segmentIndex: number,
  trailingSlash: boolean,
  captured: string[],
  headers?: Headers,
): RankedMatch<R> | undefined {
  if (segmentIndex === segments.length) {
    const stored = node.routes.get(trailingSlash);
    return stored ? { match: finishMatch(stored, captured, headers), ranks: [] } : undefined;
  }

  const segment = segments[segmentIndex]!;
  const staticChild = node.staticChildren.get(segment.value);
  if (staticChild) {
    const result = search(
      staticChild,
      segments,
      segmentIndex + 1,
      trailingSlash,
      captured,
      headers,
    );
    if (result) return { match: result.match, ranks: [0, ...result.ranks] };
  }

  let bestMixed: RankedMatch<R> | undefined;
  for (const edge of node.mixedChildren.values()) {
    const matched = edge.matcher.exec(segment.value);
    if (!matched) continue;
    const capturedLength = captured.length;
    for (let captureIndex = 1; captureIndex < matched.indices!.length; captureIndex++) {
      const range = matched.indices![captureIndex];
      const [start, end] = range!;
      captured.push(rawSegmentSlice(segment, start, end));
    }
    const result = search(edge.child, segments, segmentIndex + 1, trailingSlash, captured, headers);
    captured.length = capturedLength;
    if (!result) continue;
    const ranked = { match: result.match, ranks: [1, ...result.ranks] };
    if (!bestMixed || compareRanks(ranked.ranks, bestMixed.ranks) < 0) {
      bestMixed = ranked;
    }
  }
  if (bestMixed) return bestMixed;

  if (node.param) {
    captured.push(segment.raw);
    const result = search(node.param, segments, segmentIndex + 1, trailingSlash, captured, headers);
    captured.pop();
    if (result) return { match: result.match, ranks: [2, ...result.ranks] };
  }
  return undefined;
}

export function createRadixMatcher<R>(
  routes: ReadonlyArray<RouteMatcherInput<R>>,
): RouteMatcher<R> {
  const roots = new Map<string, RadixNode<R>>();
  for (const route of normalizeRouteInputs(routes)) {
    let root = roots.get(route.method);
    if (!root) {
      root = createNode();
      roots.set(route.method, root);
    }
    insertRoute(root, route);
  }

  return {
    match(method, pathname, headers) {
      const root = roots.get(method);
      const parsed = canonicalizePathname(pathname);
      if (!root || !parsed) return null;
      return search(root, parsed.segments, 0, parsed.trailingSlash, [], headers)?.match ?? null;
    },
  };
}
