import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
  type McpHttpHandler,
  type McpServerFactory,
  type PerRequestResponseMode,
} from "@modelcontextprotocol/server";
import type { McpInboundAuthInfo, MaybePromise } from "@typespex/mcp-server";

export type InboundAuthVerifier = (
  request: Request,
) => MaybePromise<McpInboundAuthInfo | Response | undefined>;

export interface McpHttpServerOptions {
  /** Address used by the standalone Node and Bun launchers. */
  readonly host?: string;
  /** Port used by the standalone Node and Bun launchers. */
  readonly port?: number;
  /** Mount path. Defaults to `/mcp`. */
  readonly path?: string;
  /** Hostnames accepted in the Host header. Ports are ignored. */
  readonly allowedHosts?: readonly string[];
  /** Exact HTTP(S) origins accepted in the Origin header. Requests without Origin are allowed. */
  readonly allowedOrigins?: readonly string[];
  /** Verifies inbound authentication and supplies SDK AuthInfo to tool handlers. */
  readonly verifyAuth?: InboundAuthVerifier;
  readonly legacy?: "stateless" | "reject";
  readonly responseMode?: PerRequestResponseMode;
  readonly onError?: (error: Error) => void;
}

export interface ResolvedMcpHttpServerOptions {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly exactOriginValidation: boolean;
  /** Whether this configuration can accept non-loopback traffic and therefore requires auth. */
  readonly requiresAuth: boolean;
  readonly verifyAuth?: InboundAuthVerifier;
  readonly legacy: "stateless" | "reject";
  readonly responseMode: PerRequestResponseMode;
  readonly onError?: (error: Error) => void;
}

/**
 * Creates a fetch-native, security-gated MCP handler. It can be mounted in Bun,
 * Hono, Workers, or adapted to Node with `toNodeHandler` from `@typespex/adapter-node`.
 */
export function createTypespexHttpHandler(
  factory: McpServerFactory,
  options: McpHttpServerOptions = {},
): McpHttpHandler {
  const resolved = resolveMcpHttpServerOptions(options);
  const handler = createMcpHandler(factory, {
    legacy: resolved.legacy,
    responseMode: resolved.responseMode,
    onerror: resolved.onError,
  });

  return {
    ...handler,
    async fetch(request, requestOptions) {
      if (new URL(request.url).pathname !== resolved.path) {
        return new Response("Not found.", { status: 404 });
      }

      const rejected =
        hostHeaderValidationResponse(request, [...resolved.allowedHosts]) ??
        (resolved.exactOriginValidation
          ? exactOriginValidationResponse(request, resolved.allowedOrigins)
          : originValidationResponse(request, [...resolved.allowedOrigins]));
      if (rejected) return rejected;

      let authInfo = requestOptions?.authInfo;
      if (resolved.verifyAuth) {
        try {
          const verified = await resolved.verifyAuth(request);
          if (verified instanceof Response) return verified;
          authInfo = verified
            ? {
                ...verified,
                scopes: [...verified.scopes],
                ...(verified.extra ? { extra: { ...verified.extra } } : {}),
              }
            : undefined;
        } catch (error) {
          resolved.onError?.(asError(error));
          return unauthorizedResponse();
        }
      }

      if (resolved.requiresAuth && !authInfo) return unauthorizedResponse();
      return handler.fetch(request, { ...requestOptions, authInfo });
    },
  };
}

export function resolveMcpHttpServerOptions(
  options: McpHttpServerOptions = {},
): ResolvedMcpHttpServerOptions {
  const host = normalizeHost(options.host ?? "127.0.0.1");
  const port = options.port ?? 3000;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError(`Invalid MCP HTTP port: ${String(port)}.`);
  }
  const path = normalizePath(options.path ?? "/mcp");
  const loopback = isLoopbackHost(host);
  const allowedHosts =
    options.allowedHosts?.map(normalizeAllowlistHostname) ??
    (loopback ? localhostAllowedHostnames() : []);
  const exactOriginValidation = options.allowedOrigins !== undefined;
  const allowedOrigins =
    options.allowedOrigins?.map(normalizeAllowedOrigin) ??
    (loopback ? localhostAllowedOrigins() : []);
  const requiresAuth =
    !loopback ||
    allowedHosts.some((allowed) => !isLoopbackHost(allowed)) ||
    allowedOrigins.some(
      (allowed) => !isLoopbackHost(exactOriginValidation ? new URL(allowed).hostname : allowed),
    );
  if (
    requiresAuth &&
    (!options.allowedHosts?.length || !options.allowedOrigins?.length || !options.verifyAuth)
  ) {
    throw new TypeError(
      "Non-loopback MCP HTTP servers require allowedHosts, allowedOrigins, and verifyAuth.",
    );
  }

  return {
    host,
    port,
    path,
    allowedHosts,
    allowedOrigins,
    exactOriginValidation,
    requiresAuth,
    verifyAuth: options.verifyAuth,
    legacy: options.legacy ?? "stateless",
    responseMode: options.responseMode ?? "auto",
    onError: options.onError,
  };
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host).toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") return true;
  const match = /^(?:\[?::ffff:)?127(?:\.\d{1,3}){3}\]?$/.exec(normalized);
  return match !== null;
}

function normalizeHost(host: string): string {
  for (const character of host) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      throw new TypeError(`Invalid MCP HTTP host: ${host}.`);
    }
  }
  const trimmed = host.trim();
  for (const character of trimmed) {
    if (character.trim() === "" || "/?#@\\".includes(character)) {
      throw new TypeError(`Invalid MCP HTTP host: ${host}.`);
    }
  }
  if (!trimmed) throw new TypeError(`Invalid MCP HTTP host: ${host}.`);
  return trimmed;
}

function normalizePath(path: string): string {
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
    throw new TypeError(`Invalid MCP HTTP path: ${path}.`);
  }
  if (path.length === 1) return path;
  let end = path.length;
  while (end > 1 && path.charCodeAt(end - 1) === 47) end--;
  return path.slice(0, end);
}

function normalizeAllowlistHostname(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError("MCP HTTP allowlists cannot contain empty values.");
  try {
    return new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`).hostname;
  } catch {
    throw new TypeError(`Invalid MCP HTTP allowlist hostname: ${value}.`);
  }
}

function normalizeAllowedOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError("MCP HTTP origin allowlists cannot contain empty values.");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new TypeError(`Invalid MCP HTTP origin: ${value}.`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(`Invalid MCP HTTP origin: ${value}.`);
  }
  return url.origin;
}

function exactOriginValidationResponse(
  request: Request,
  allowedOrigins: readonly string[],
): Response | undefined {
  const origin = request.headers.get("Origin");
  if (!origin) return undefined;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return invalidOriginResponse(origin);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !allowedOrigins.includes(url.origin)
  ) {
    return invalidOriginResponse(origin);
  }
  return undefined;
}

function invalidOriginResponse(origin: string): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32_000, message: `Invalid Origin: ${origin}` },
      id: null,
    },
    { status: 403 },
  );
}

function unauthorizedResponse(): Response {
  return new Response("Unauthorized.", {
    status: 401,
    headers: { "WWW-Authenticate": "Bearer" },
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
