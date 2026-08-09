import type {
  RouteMatcherInput,
  RoutePattern,
  RoutePatternSegment,
  RoutePatternToken,
} from "./matcher.js";
import { canonicalizeRouteLiteral } from "./match-path.js";

// RFC 3986 reserved characters that remain visible boundaries because simple
// URI-template variable expansions percent-encode them inside values.
const SAFE_PARAMETER_BOUNDARY = /[:[\]@!$&'()*+,;=]/;

export type RouteSegmentKind = "static" | "mixed" | "parameter";

export interface NormalizedRouteInput<R> {
  readonly method: string;
  readonly path: string;
  readonly pattern: RoutePattern;
  readonly structure: string;
  readonly segmentKinds: readonly RouteSegmentKind[];
  readonly parameterNames: readonly string[];
  readonly route: R;
}

/** Validates and splits one legacy colon-parameter route pattern. */
export function routeSegments(path: string): string[] {
  const pattern = legacyRoutePattern(path);
  return pattern.segments.map((segment) => {
    const token = segment[0]!;
    return token.kind === "parameter" ? `:${token.name}` : token.value;
  });
}

/** Structural key used to reject routes that differ only by parameter name. */
export function routeStructure(path: string): string {
  return routePatternStructure(legacyRoutePattern(path));
}

/** Normalizes and validates all matcher registrations, including conflicts. */
export function normalizeRouteInputs<R>(
  routes: ReadonlyArray<RouteMatcherInput<R>>,
): NormalizedRouteInput<R>[] {
  const normalized: NormalizedRouteInput<R>[] = [];
  const byMethod = new Map<string, NormalizedRouteInput<R>[]>();

  for (const route of routes) {
    const pattern =
      route.routePattern === undefined
        ? legacyRoutePattern(route.path)
        : normalizeStructuredPattern(route.routePattern, route.path);
    const structure = routePatternStructure(pattern);
    const parameterNames: string[] = [];
    const segmentKinds = pattern.segments.map((segment) => {
      for (const token of segment) {
        if (token.kind === "parameter") parameterNames.push(token.name);
      }
      return routePatternSegmentKind(segment);
    });
    const current: NormalizedRouteInput<R> = {
      method: route.method,
      path: route.path,
      pattern,
      structure,
      segmentKinds,
      parameterNames,
      route: route.route,
    };

    const sameMethod = byMethod.get(route.method) ?? [];
    for (const previous of sameMethod) {
      if (previous.structure === structure) {
        throw new Error(`Duplicate route: ${route.method} ${route.path}`);
      }
      if (routePatternsAreAmbiguous(previous, current)) {
        throw new Error(
          `Ambiguous route: ${route.method} ${route.path} conflicts with ${previous.path}`,
        );
      }
    }
    sameMethod.push(current);
    byMethod.set(route.method, sameMethod);
    normalized.push(current);
  }

  return normalized;
}

/** Stable structural identity that deliberately excludes parameter names. */
export function routePatternStructure(pattern: RoutePattern): string {
  return JSON.stringify({
    segments: pattern.segments.map((segment) =>
      segment.map((token) => (token.kind === "literal" ? ["literal", token.value] : ["parameter"])),
    ),
    trailingSlash: pattern.trailingSlash,
  });
}

export function routePatternSegmentKind(segment: RoutePatternSegment): RouteSegmentKind {
  if (segment.length === 1 && segment[0]!.kind === "literal") return "static";
  if (segment.length === 1 && segment[0]!.kind === "parameter") return "parameter";
  return "mixed";
}

function legacyRoutePattern(path: string): RoutePattern {
  if (path === "/") return { segments: [], trailingSlash: true };
  if (!path.startsWith("/") || path.endsWith("/") || path.includes("//")) {
    throw new Error(`Invalid route path: ${path}`);
  }
  if (path.includes("?") || path.includes("#")) {
    throw new Error(`Invalid route path: ${path}`);
  }

  const parameters = new Set<string>();
  const segments: RoutePatternSegment[] = path
    .substring(1)
    .split("/")
    .map((segment): RoutePatternSegment => {
      if (!segment.startsWith(":")) {
        return [{ kind: "literal", value: canonicalizeRouteLiteral(segment) }];
      }
      const name = segment.substring(1);
      if (name.length === 0) throw new Error(`Invalid route path: ${path}`);
      if (parameters.has(name)) {
        throw new Error(`Duplicate path parameter "${name}" in route: ${path}`);
      }
      parameters.add(name);
      return [{ kind: "parameter", name }];
    });
  return { segments, trailingSlash: false };
}

function normalizeStructuredPattern(pattern: RoutePattern, path: string): RoutePattern {
  if (
    typeof pattern !== "object" ||
    pattern === null ||
    !Array.isArray(pattern.segments) ||
    typeof pattern.trailingSlash !== "boolean"
  ) {
    throw new Error(`Invalid route pattern: ${path}`);
  }
  if (pattern.segments.length === 0) {
    if (!pattern.trailingSlash) throw new Error(`Invalid route pattern: ${path}`);
    return { segments: [], trailingSlash: true };
  }

  const parameterNames = new Set<string>();
  const segments = pattern.segments.map((segment) =>
    normalizeStructuredSegment(segment, path, parameterNames),
  );
  return { segments, trailingSlash: pattern.trailingSlash };
}

function normalizeStructuredSegment(
  segment: RoutePatternSegment,
  path: string,
  parameterNames: Set<string>,
): RoutePatternSegment {
  if (!Array.isArray(segment) || segment.length === 0) {
    throw new Error(`Invalid route pattern: ${path}`);
  }

  const normalized: RoutePatternToken[] = [];
  for (const token of segment) {
    if (typeof token !== "object" || token === null) {
      throw new Error(`Invalid route pattern: ${path}`);
    }
    if (token.kind === "literal") {
      if (
        typeof token.value !== "string" ||
        token.value.includes("/") ||
        token.value.includes("?") ||
        token.value.includes("#")
      ) {
        throw new Error(`Invalid route pattern: ${path}`);
      }
      if (token.value.length === 0) continue;
      const value = canonicalizeRouteLiteral(token.value);
      const previous = normalized.at(-1);
      if (previous?.kind === "literal") {
        normalized[normalized.length - 1] = {
          kind: "literal",
          value: previous.value + value,
        };
      } else {
        normalized.push({ kind: "literal", value });
      }
      continue;
    }
    if (token.kind !== "parameter" || typeof token.name !== "string" || token.name.length === 0) {
      throw new Error(`Invalid route pattern: ${path}`);
    }
    if (parameterNames.has(token.name)) {
      throw new Error(`Duplicate path parameter "${token.name}" in route: ${path}`);
    }
    if (normalized.at(-1)?.kind === "parameter") {
      throw new Error(`Ambiguous adjacent path parameters in route: ${path}`);
    }
    const previous = normalized.at(-1);
    const beforePrevious = normalized.at(-2);
    if (
      previous?.kind === "literal" &&
      beforePrevious?.kind === "parameter" &&
      !SAFE_PARAMETER_BOUNDARY.test(previous.value)
    ) {
      throw new Error(`Ambiguous path parameter boundary in route: ${path}`);
    }
    parameterNames.add(token.name);
    normalized.push({ kind: "parameter", name: token.name });
  }

  if (normalized.length === 0) throw new Error(`Invalid route pattern: ${path}`);
  return normalized;
}

function routePatternsAreAmbiguous<R>(
  left: NormalizedRouteInput<R>,
  right: NormalizedRouteInput<R>,
): boolean {
  if (
    left.pattern.trailingSlash !== right.pattern.trailingSlash ||
    left.pattern.segments.length !== right.pattern.segments.length
  ) {
    return false;
  }
  for (let index = 0; index < left.segmentKinds.length; index++) {
    if (left.segmentKinds[index] !== right.segmentKinds[index]) return false;
  }
  // With no mixed segments, equal kind vectors are either structurally
  // identical (handled as duplicates above) or differ at a static segment.
  if (!left.segmentKinds.includes("mixed")) return false;
  return left.pattern.segments.every((segment, index) =>
    segmentLanguagesOverlap(segment, right.pattern.segments[index]!),
  );
}

interface NfaTransition {
  readonly character?: string;
  readonly any?: true;
  readonly to: number;
}

interface SegmentNfa {
  readonly transitions: readonly (readonly NfaTransition[])[];
  readonly epsilon: readonly (readonly number[])[];
  readonly accept: number;
}

/** Tests intersection emptiness for segment languages made from literals and parameter wildcards. */
function segmentLanguagesOverlap(left: RoutePatternSegment, right: RoutePatternSegment): boolean {
  const leftNfa = compileSegmentNfa(left);
  const rightNfa = compileSegmentNfa(right);
  const leftStart = epsilonClosure(leftNfa, [0]);
  const rightStart = epsilonClosure(rightNfa, [0]);
  const queue: Array<readonly [readonly number[], readonly number[]]> = [[leftStart, rightStart]];
  const seen = new Set<string>();

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
    const [leftStates, rightStates] = queue[queueIndex]!;
    const key = `${leftStates.join(",")}|${rightStates.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (leftStates.includes(leftNfa.accept) && rightStates.includes(rightNfa.accept)) return true;

    const explicitCharacters = new Set<string>();
    collectTransitionCharacters(leftNfa, leftStates, explicitCharacters);
    collectTransitionCharacters(rightNfa, rightStates, explicitCharacters);
    const characters = [...explicitCharacters, otherCharacter(explicitCharacters)];
    for (const character of characters) {
      const nextLeft = moveNfa(leftNfa, leftStates, character);
      if (nextLeft.length === 0) continue;
      const nextRight = moveNfa(rightNfa, rightStates, character);
      if (nextRight.length === 0) continue;
      queue.push([nextLeft, nextRight]);
    }
  }
  return false;
}

function compileSegmentNfa(segment: RoutePatternSegment): SegmentNfa {
  const transitions: NfaTransition[][] = [[]];
  const epsilon: number[][] = [[]];
  const parametersMayBeEmpty = routePatternSegmentKind(segment) === "mixed";
  let current = 0;
  const newState = (): number => {
    transitions.push([]);
    epsilon.push([]);
    return transitions.length - 1;
  };

  for (const token of segment) {
    if (token.kind === "literal") {
      for (let index = 0; index < token.value.length; index++) {
        const next = newState();
        transitions[current]!.push({ character: token.value[index]!, to: next });
        current = next;
      }
    } else {
      const repeated = newState();
      const next = newState();
      transitions[current]!.push({ any: true, to: repeated });
      if (parametersMayBeEmpty) epsilon[current]!.push(next);
      transitions[repeated]!.push({ any: true, to: repeated });
      epsilon[repeated]!.push(next);
      current = next;
    }
  }
  return { transitions, epsilon, accept: current };
}

function epsilonClosure(nfa: SegmentNfa, initial: readonly number[]): number[] {
  const closure = new Set(initial);
  const stack = [...initial];
  while (stack.length > 0) {
    const state = stack.pop()!;
    for (const next of nfa.epsilon[state]!) {
      if (closure.has(next)) continue;
      closure.add(next);
      stack.push(next);
    }
  }
  return [...closure].sort((a, b) => a - b);
}

function moveNfa(nfa: SegmentNfa, states: readonly number[], character: string): number[] {
  const moved = new Set<number>();
  for (const state of states) {
    for (const transition of nfa.transitions[state]!) {
      if (transition.any || transition.character === character) moved.add(transition.to);
    }
  }
  return moved.size === 0 ? [] : epsilonClosure(nfa, [...moved]);
}

function collectTransitionCharacters(
  nfa: SegmentNfa,
  states: readonly number[],
  target: Set<string>,
): void {
  for (const state of states) {
    for (const transition of nfa.transitions[state]!) {
      if (transition.character !== undefined) target.add(transition.character);
    }
  }
}

function otherCharacter(explicit: ReadonlySet<string>): string {
  for (let code = 0; code <= 0xffff; code++) {
    const candidate = String.fromCharCode(code);
    if (candidate !== "/" && !explicit.has(candidate)) return candidate;
  }
  throw new Error("Unable to construct route-language sentinel.");
}
