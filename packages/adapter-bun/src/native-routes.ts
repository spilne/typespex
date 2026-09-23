import type { Serve } from "bun";
import {
  getHttpTransportRoutes,
  type HttpRouter,
  type HttpTransportRoute,
} from "@typespex/http-server";
import { framedRequestBody } from "./transport.js";

const EMPTY_PARAMS: Readonly<Record<string, string>> = Object.freeze(Object.create(null));
const METHODS = new Set<string>(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);
const UNRESERVED_CAPTURE = /^[A-Za-z0-9_~-]+$/;
const SIMPLE_AUTHORITY = /^[A-Za-z0-9._-]+(?::[0-9]{1,5})?$/;

interface CaptureStep {
  readonly name: string;
  readonly key: string;
  readonly prefix: string;
}

/** Uses native dispatch only when the entire route table has equivalent Bun patterns. */
export function createNativeRoutes(
  router: HttpRouter,
  fallback: (request: Request) => Response | Promise<Response>,
): Serve.Routes<undefined, string> | undefined {
  const registrations = getHttpTransportRoutes(router);
  if (!registrations?.length) return undefined;

  const routes: Record<
    string,
    Partial<Record<Serve.HTTPMethod, (request: Request) => Response | Promise<Response>>>
  > = Object.create(null);
  for (const route of registrations) {
    if (!METHODS.has(route.method)) return undefined;
    // Bun exposes no GET/HEAD body; the ordinary limiter still checks Content-Length.
    const needsBodyFraming = route.method !== "GET" && route.method !== "HEAD";
    const captureSteps: CaptureStep[] = [];
    let literalPrefix = "";
    const segments: string[] = [];
    for (const segment of route.pattern.segments) {
      if (segment.length !== 1) return undefined;
      const token = segment[0]!;
      if (token.kind === "literal") {
        // Exclude Bun pattern syntax, escaped literals, and Unicode normalization.
        if (token.value === "." || token.value === ".." || !/^[A-Za-z0-9._~-]+$/.test(token.value))
          return undefined;
        segments.push(token.value);
        literalPrefix += `/${token.value}`;
      } else if (token.kind === "parameter") {
        const key = `p${captureSteps.length}`;
        captureSteps.push({ name: token.name, key, prefix: literalPrefix + "/" });
        literalPrefix = "";
        segments.push(`:${key}`);
      } else return undefined;
    }
    const path = `/${segments.join("/")}${segments.length && route.pattern.trailingSlash ? "/" : ""}`;
    const suffix = literalPrefix;
    // A decoded capture may equal a competing route's literal, even though Bun
    // selected the parameter route from its encoded spelling. Keep full matching
    // whenever another pattern could outrank that native selection.
    // The accepted captures exclude dots, slashes and empty values, so URL
    // normalization cannot change segment counts or the trailing separator.
    const decodedDispatch = !registrations.some((other) => patternsOverlap(route, other))
      ? route.dispatchDecodedPath
      : undefined;
    const methods = (routes[path] ??= {});
    methods[route.method as Serve.HTTPMethod] = (request) => {
      if (request.method !== route.method) return fallback(request);
      // Bun matches literals and separators before decoding captures. A simple
      // authority and unreserved captures cannot change pathname normalization.
      // Other authorities, escaped separators, dot segments and invalid UTF-8
      // retain the URL verification below.
      if ((!captureSteps.length || decodedDispatch) && hasSimpleAuthority(request)) {
        if (!captureSteps.length) {
          const transport = needsBodyFraming ? framedRequestBody(request) : undefined;
          return route.dispatch
            ? route.dispatch(request, EMPTY_PARAMS, Bun.peek, transport)
            : route.handle(request, EMPTY_PARAMS, transport);
        }
        const native = (request as Request & { params: Record<string, string> }).params;
        const decoded: Record<string, string> = Object.create(null);
        let safe = true;
        for (const capture of captureSteps) {
          const value = native[capture.key];
          if (typeof value !== "string" || !UNRESERVED_CAPTURE.test(value)) {
            safe = false;
            break;
          }
          decoded[capture.name] = value;
        }
        if (safe) {
          let raw: Readonly<Record<string, string>> | undefined;
          return decodedDispatch!(
            request,
            decoded,
            () => (raw ??= readRawCaptures(request.url, captureSteps)),
            Bun.peek,
            needsBodyFraming ? framedRequestBody(request) : undefined,
          );
        }
      }
      const pathname = readPathname(request.url);
      if (pathname.includes("%") || pathname.includes("//")) {
        return fallback(request);
      }

      let matchedPath = path;
      let pathParams = EMPTY_PARAMS;
      if (captureSteps.length) {
        const native = (request as Request & { params: Record<string, string> }).params;
        const captures: Record<string, string> = Object.create(null);
        matchedPath = "";
        for (const capture of captureSteps) {
          const value = native[capture.key]!;
          if (!value || value.includes("/")) return fallback(request);
          matchedPath += capture.prefix + value;
          captures[capture.name] = value;
        }
        matchedPath += suffix;
        if (route.pattern.trailingSlash) matchedPath += "/";
        pathParams = captures;
      }
      // Bun dispatches the raw request target, while Request.url normalizes dot
      // segments and backslashes and incorporates Host. Only trust its selection
      // when reconstructing that target agrees with the router's pathname.
      if (matchedPath !== pathname) return fallback(request);
      const transport = needsBodyFraming ? framedRequestBody(request) : undefined;
      return route.dispatch
        ? route.dispatch(request, pathParams, Bun.peek, transport)
        : route.handle(request, pathParams, transport);
    };
  }
  return routes;
}

function hasSimpleAuthority(request: Request): boolean {
  const host = request.headers.get("host");
  if (!host || !SIMPLE_AUTHORITY.test(host)) return false;
  const colon = host.lastIndexOf(":");
  return colon === -1 || Number(host.substring(colon + 1)) <= 65535;
}

function patternsOverlap(left: HttpTransportRoute, right: HttpTransportRoute): boolean {
  if (
    left === right ||
    left.method !== right.method ||
    left.pattern.trailingSlash !== right.pattern.trailingSlash ||
    left.pattern.segments.length !== right.pattern.segments.length
  )
    return false;
  return left.pattern.segments.every((segment, index) => {
    const other = right.pattern.segments[index]!;
    const a = segment[0],
      b = other[0];
    return (
      segment.length !== 1 ||
      other.length !== 1 ||
      !a ||
      !b ||
      a.kind !== "literal" ||
      b.kind !== "literal" ||
      a.value === b.value
    );
  });
}

function readPathname(url: string): string {
  // Bun can expose a relative URL when an otherwise simple Host is not a
  // valid WHATWG authority (for example an out-of-range numeric IPv4 host).
  const scheme = url.indexOf("://");
  const start = scheme === -1 ? 0 : url.indexOf("/", scheme + 3);
  const query = url.indexOf("?", start);
  return url.substring(start, query === -1 ? url.length : query);
}

function readRawCaptures(
  url: string,
  captures: readonly CaptureStep[],
): Readonly<Record<string, string>> {
  const pathname = readPathname(url);
  const output: Record<string, string> = Object.create(null);
  let cursor = 0;
  for (const capture of captures) {
    cursor += capture.prefix.length;
    const slash = pathname.indexOf("/", cursor);
    const end = slash === -1 ? pathname.length : slash;
    output[capture.name] = pathname.substring(cursor, end);
    cursor = end;
  }
  return output;
}
