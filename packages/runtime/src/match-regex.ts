/**
 * Single-regex matcher — one compiled regex per HTTP method.
 * All routes compiled into one regex; one native exec() call matches + extracts params.
 */

import type { RouteMatch, RouteMatcher } from "./matcher.js";

const EMPTY_PARAMS: Record<string, string> = Object.freeze(Object.create(null));

interface RouteGroupInfo<R> {
  route: R;
  paramNames: string[];
  firstGroup: number;
}

interface CompiledMethodRouter<R> {
  regex: RegExp;
  /** Sparse: groupIndex → RouteGroupInfo (set only at each route's firstGroup) */
  groupToRoute: Array<RouteGroupInfo<R> | undefined>;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileMethodRoutes<R>(
  routes: Array<{ path: string; route: R }>,
): CompiledMethodRouter<R> {
  const alternatives: string[] = [];
  const groupToRoute: Array<RouteGroupInfo<R> | undefined> = [];
  let nextGroup = 1;

  for (const { path, route } of routes) {
    const paramNames: string[] = [];
    const firstGroup = nextGroup;

    let pattern = "";
    for (const seg of path.split("/").filter(Boolean)) {
      pattern += "\\/";
      if (seg.startsWith(":")) {
        paramNames.push(seg.slice(1));
        pattern += "([^\\/]+)";
        nextGroup++;
      } else {
        pattern += escapeRegex(seg);
      }
    }

    // Routes with no params need a marker group to detect the match
    if (paramNames.length === 0) {
      pattern = `(${pattern})`;
      nextGroup++;
    }

    alternatives.push(pattern);
    groupToRoute[firstGroup] = { route, paramNames, firstGroup };
  }

  const regex = new RegExp(`^(?:${alternatives.join("|")})$`);
  return { regex, groupToRoute };
}

function regexLookup<R>(
  compiled: CompiledMethodRouter<R>,
  pathname: string,
): RouteMatch<R> | null {
  const match = compiled.regex.exec(pathname);
  if (!match) return null;

  for (let i = 1; i < match.length; i++) {
    if (match[i] === undefined) continue;

    const info = compiled.groupToRoute[i];
    if (!info) continue;

    if (info.paramNames.length === 0) {
      return { route: info.route, pathParams: EMPTY_PARAMS };
    }
    const pathParams: Record<string, string> = Object.create(null);
    for (let p = 0; p < info.paramNames.length; p++) {
      pathParams[info.paramNames[p]] = match[info.firstGroup + p];
    }
    return { route: info.route, pathParams };
  }

  return null;
}

export function createRegexMatcher<R>(
  routes: Array<{ method: string; path: string; route: R }>,
): RouteMatcher<R> {
  const perMethod = new Map<string, Array<{ path: string; route: R }>>();
  const seen = new Set<string>();

  for (const { method, path, route } of routes) {
    const key = `${method} ${path}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate route: ${key}`);
    }
    seen.add(key);

    let group = perMethod.get(method);
    if (!group) {
      group = [];
      perMethod.set(method, group);
    }
    group.push({ path, route });
  }

  const compiled = new Map<string, CompiledMethodRouter<R>>();
  for (const [method, group] of perMethod) {
    compiled.set(method, compileMethodRoutes(group));
  }

  return {
    match(method, pathname) {
      const router = compiled.get(method);
      if (!router) return null;
      return regexLookup(router, pathname);
    },
  };
}
