import type { Serve } from "bun";
import { getHttpTransportRoutes, type HttpRouter } from "@typespex/http-server";
import { framedRequestBody } from "./transport.js";

const EMPTY_PARAMS: Readonly<Record<string, string>> = Object.freeze(Object.create(null));
const METHODS = new Set<string>(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);

/** Uses native dispatch only when the entire route table has equivalent Bun patterns. */
export function createNativeRoutes(
  router: HttpRouter,
  fallback: (request: Request) => Promise<Response>,
): Serve.Routes<undefined, string> | undefined {
  const registrations = getHttpTransportRoutes(router);
  if (!registrations?.length) return undefined;

  const routes: Record<
    string,
    Partial<Record<Serve.HTTPMethod, (request: Request) => Promise<Response>>>
  > = Object.create(null);
  for (const route of registrations) {
    if (!METHODS.has(route.method)) return undefined;
    const parameterNames: string[] = [];
    const segments: string[] = [];
    for (const segment of route.pattern.segments) {
      if (segment.length !== 1) return undefined;
      const token = segment[0]!;
      if (token.kind === "literal") {
        // Exclude Bun pattern syntax, escaped literals, and Unicode normalization.
        if (!/^[A-Za-z0-9._~-]+$/.test(token.value)) return undefined;
        segments.push(token.value);
      } else if (token.kind === "parameter") {
        segments.push(`:p${parameterNames.length}`);
        parameterNames.push(token.name);
      } else return undefined;
    }
    const path = `/${segments.join("/")}${segments.length && route.pattern.trailingSlash ? "/" : ""}`;
    const methods = (routes[path] ??= {});
    methods[route.method as Serve.HTTPMethod] = (request) => {
      const url = request.url;
      const start = url.indexOf("/", url.indexOf("://") + 3);
      const query = url.indexOf("?", start);
      const pathname = url.substring(start, query === -1 ? url.length : query);
      if (request.method !== route.method || pathname.includes("%") || pathname.includes("//")) {
        return fallback(request);
      }

      let matchedPath = path;
      let pathParams = EMPTY_PARAMS;
      if (parameterNames.length) {
        const native = (request as Request & { params: Record<string, string> }).params;
        const captures: Record<string, string> = Object.create(null);
        let parameter = 0;
        matchedPath = "";
        for (const segment of route.pattern.segments) {
          const token = segment[0]!;
          if (token.kind === "literal") matchedPath += `/${token.value}`;
          else {
            const value = native[`p${parameter++}`]!;
            if (!value || value.includes("/")) return fallback(request);
            matchedPath += `/${value}`;
            captures[token.name] = value;
          }
        }
        if (route.pattern.trailingSlash) matchedPath += "/";
        pathParams = captures;
      }
      // Bun dispatches the raw request target, while Request.url normalizes dot
      // segments and backslashes and incorporates Host. Only trust its selection
      // when reconstructing that target agrees with the router's pathname.
      if (matchedPath !== pathname) return fallback(request);
      return route.handle(request, pathParams, framedRequestBody(request));
    };
  }
  return routes;
}
