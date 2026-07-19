/** Validates and splits one colon-parameter route pattern. */
export function routeSegments(path: string): string[] {
  if (path === "/") return [];
  if (!path.startsWith("/") || path.endsWith("/") || path.includes("//")) {
    throw new Error(`Invalid route path: ${path}`);
  }
  if (path.includes("?") || path.includes("#")) {
    throw new Error(`Invalid route path: ${path}`);
  }

  const segments = path.substring(1).split("/");
  const parameters = new Set<string>();
  for (const segment of segments) {
    if (!segment.startsWith(":")) continue;
    const name = segment.substring(1);
    if (name.length === 0) throw new Error(`Invalid route path: ${path}`);
    if (parameters.has(name)) {
      throw new Error(`Duplicate path parameter "${name}" in route: ${path}`);
    }
    parameters.add(name);
  }
  return segments;
}

/** Structural key used to reject routes that differ only by parameter name. */
export function routeStructure(path: string): string {
  return JSON.stringify(
    routeSegments(path).map((segment) => (segment.startsWith(":") ? null : segment)),
  );
}
