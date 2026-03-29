/**
 * Compressed radix tree matcher — one tree per HTTP method.
 * O(m) matching where m = number of path segments, fewer hops due to compression.
 */

import type { RouteMatch, RouteMatcher } from "./matcher.js";

// ── Build (uncompressed trie) ──

interface BuildNode {
  children: Map<string, BuildNode>;
  param?: { name: string; child: BuildNode };
  route?: unknown;
}

// ── Runtime (compressed, multi-segment static edges) ──

interface RadixNode {
  children: Map<string, { tail: string[]; child: RadixNode }>;
  param?: { name: string; child: RadixNode };
  route?: unknown;
}

function createBuildNode(): BuildNode {
  return { children: new Map() };
}

function trieInsert<R>(root: BuildNode, pattern: string, route: R): void {
  const segments = pattern.split("/").filter(Boolean);
  let node = root;

  for (const seg of segments) {
    if (seg.startsWith(":")) {
      if (!node.param) {
        node.param = { name: seg.slice(1), child: createBuildNode() };
      }
      node = node.param.child;
    } else {
      let child = node.children.get(seg);
      if (!child) {
        child = createBuildNode();
        node.children.set(seg, child);
      }
      node = child;
    }
  }

  node.route = route;
}

function compress(build: BuildNode): RadixNode {
  const node: RadixNode = {
    children: new Map(),
    route: build.route,
  };

  if (build.param) {
    node.param = { name: build.param.name, child: compress(build.param.child) };
  }

  for (const [seg, child] of build.children) {
    const tail: string[] = [];
    let cur = child;
    while (
      cur.route === undefined &&
      cur.param === undefined &&
      cur.children.size === 1
    ) {
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

function radixLookup<R>(
  root: RadixNode,
  pathname: string,
): RouteMatch<R> | null {
  // Reject trailing slash for consistent matching with regex matcher
  if (pathname.length > 1 && pathname.charCodeAt(pathname.length - 1) === 0x2f) return null;

  let node = root;
  let params: Record<string, string> | undefined;
  let i = 0;
  const len = pathname.length;

  if (i < len && pathname.charCodeAt(i) === 0x2f) i++;

  while (i < len) {
    const j = nextSegment(pathname, i, len);
    const seg = pathname.substring(i, j);

    const edge = node.children.get(seg);
    if (edge) {
      let pos = j + 1;
      let matched = true;
      for (let t = 0; t < edge.tail.length; t++) {
        if (pos >= len) { matched = false; break; }
        const end = nextSegment(pathname, pos, len);
        if (pathname.substring(pos, end) !== edge.tail[t]) { matched = false; break; }
        pos = end + 1;
      }
      if (matched) {
        node = edge.child;
        i = pos;
        continue;
      }
    }

    if (node.param) {
      if (!params) params = Object.create(null) as Record<string, string>;
      params[node.param.name] = seg;
      node = node.param.child;
      i = j + 1;
      continue;
    }

    return null;
  }

  if (node.route === undefined) return null;
  return { route: node.route as R, pathParams: params ?? Object.create(null) };
}

export function createRadixMatcher<R>(
  routes: Array<{ method: string; path: string; route: R }>,
): RouteMatcher<R> {
  const buildTrees = new Map<string, BuildNode>();

  for (const { method, path, route } of routes) {
    let root = buildTrees.get(method);
    if (!root) {
      root = createBuildNode();
      buildTrees.set(method, root);
    }
    trieInsert(root, path, route);
  }

  const trees = new Map<string, RadixNode>();
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
