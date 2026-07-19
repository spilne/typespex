/**
 * Compressed radix tree matcher — one tree per HTTP method.
 * O(m) matching where m = number of path segments, fewer hops due to compression.
 */

import type { RouteMatch, RouteMatcher } from "./matcher.js";
import { routeSegments, routeStructure } from "./match-common.js";

const EMPTY_PARAMS: Record<string, string> = Object.freeze(Object.create(null));

// ── Build (uncompressed trie) ──

interface StoredRoute<R> {
  value: R;
  paramNames: string[];
}

interface BuildNode<R> {
  children: Map<string, BuildNode<R>>;
  param?: BuildNode<R>;
  route?: StoredRoute<R>;
}

// ── Runtime (compressed, multi-segment static edges) ──

interface RadixNode<R> {
  children: Map<string, { tail: string[]; child: RadixNode<R> }>;
  param?: RadixNode<R>;
  route?: StoredRoute<R>;
}

function createBuildNode<R>(): BuildNode<R> {
  return { children: new Map() };
}

function trieInsert<R>(root: BuildNode<R>, pattern: string, route: R): void {
  const segments = routeSegments(pattern);
  const paramNames: string[] = [];
  let node = root;

  for (const seg of segments) {
    if (seg.startsWith(":")) {
      paramNames.push(seg.slice(1));
      if (!node.param) {
        node.param = createBuildNode();
      }
      node = node.param;
    } else {
      let child = node.children.get(seg);
      if (!child) {
        child = createBuildNode();
        node.children.set(seg, child);
      }
      node = child;
    }
  }

  node.route = { value: route, paramNames };
}

function compress<R>(build: BuildNode<R>): RadixNode<R> {
  const node: RadixNode<R> = {
    children: new Map(),
    route: build.route,
  };

  if (build.param) {
    node.param = compress(build.param);
  }

  for (const [seg, child] of build.children) {
    const tail: string[] = [];
    let cur = child;
    while (cur.route === undefined && cur.param === undefined && cur.children.size === 1) {
      const entry = cur.children.entries().next().value;
      if (!entry) break;
      const [nextSeg, nextChild] = entry;
      tail.push(nextSeg);
      cur = nextChild;
    }
    node.children.set(seg, { tail, child: compress(cur) });
  }

  return node;
}

function nextSegment(path: string, i: number, len: number): number {
  let j = i;
  while (j < len && path.charCodeAt(j) !== 0x2f) j++;
  return j;
}

function radixSearch<R>(
  node: RadixNode<R>,
  pathname: string,
  i: number,
  len: number,
  captured?: string[],
): RouteMatch<R> | null {
  if (i === len) {
    if (!node.route) return null;

    const { value, paramNames } = node.route;
    if (paramNames.length === 0) {
      return { route: value, pathParams: EMPTY_PARAMS };
    }

    const pathParams: Record<string, string> = Object.create(null);
    for (let p = 0; p < paramNames.length; p++) {
      pathParams[paramNames[p]] = captured![p];
    }
    return { route: value, pathParams };
  }

  const j = nextSegment(pathname, i, len);
  if (j === i) return null;

  const seg = pathname.substring(i, j);
  const edge = node.children.get(seg);
  if (edge) {
    let pos = j < len ? j + 1 : len;
    let matched = true;

    for (const tailSegment of edge.tail) {
      if (pos >= len) {
        matched = false;
        break;
      }

      const end = nextSegment(pathname, pos, len);
      if (end === pos || pathname.substring(pos, end) !== tailSegment) {
        matched = false;
        break;
      }
      pos = end < len ? end + 1 : len;
    }

    if (matched) {
      const match = radixSearch(edge.child, pathname, pos, len, captured);
      if (match) return match;
    }
  }

  if (node.param) {
    const values = captured ?? [];
    values.push(seg);
    const match = radixSearch(node.param, pathname, j < len ? j + 1 : len, len, values);
    if (match) return match;
    values.pop();
  }

  return null;
}

function radixLookup<R>(root: RadixNode<R>, pathname: string): RouteMatch<R> | null {
  const len = pathname.length;
  if (len === 0 || pathname.charCodeAt(0) !== 0x2f) return null;
  if (len > 1 && pathname.charCodeAt(len - 1) === 0x2f) return null;

  return radixSearch(root, pathname, 1, len);
}

export function createRadixMatcher<R>(
  routes: Array<{ method: string; path: string; route: R }>,
): RouteMatcher<R> {
  const buildTrees = new Map<string, BuildNode<R>>();
  const seenByMethod = new Map<string, Set<string>>();

  for (const { method, path, route } of routes) {
    let seen = seenByMethod.get(method);
    if (!seen) {
      seen = new Set();
      seenByMethod.set(method, seen);
    }

    const structure = routeStructure(path);
    if (seen.has(structure)) {
      throw new Error(`Duplicate route: ${method} ${path}`);
    }
    seen.add(structure);

    let root = buildTrees.get(method);
    if (!root) {
      root = createBuildNode();
      buildTrees.set(method, root);
    }
    trieInsert(root, path, route);
  }

  const trees = new Map<string, RadixNode<R>>();
  for (const [method, build] of buildTrees) {
    trees.set(method, compress(build));
  }

  return {
    match(method, pathname) {
      const root = trees.get(method);
      if (!root) return null;
      return radixLookup(root, pathname);
    },
  };
}
