import {
  consoleLogger,
  handleRequestWithTransport,
  type HttpRequestTransportInfo,
  type HttpRouter,
  type Logger,
} from "@typespex/http-server";
import { framedRequestBody } from "./transport.js";
import { errorResponse } from "./error-response.js";

interface BunRequestServer {
  requestIP(request: Request): { readonly address: string } | null;
}

export interface BunHandlerOptions {
  readonly logger?: Logger;
}

/**
 * Creates a Bun.serve-compatible handler from a Fetch router.
 *
 * Pass the returned object directly to Bun.serve. Its native callback supplies
 * an unmodified request and the server, allowing verified fixed-length bodies
 * to retain Bun's native buffering. When calling `fetch` manually or after
 * rewriting request headers, omit the optional server argument so the router
 * counts the body stream instead.
 *
 * @example
 * Bun.serve({ port: 3000, ...toBunHandler(router) });
 */
export function toBunHandler(
  router: HttpRouter,
  options?: BunHandlerOptions,
): {
  fetch: (request: Request, server?: unknown) => Promise<Response>;
} {
  const logger = options?.logger ?? consoleLogger;
  return {
    async fetch(request: Request, server?: unknown): Promise<Response> {
      try {
        const transport = verifiedRequestBody(request, server);
        if (transport) return await handleRequestWithTransport(router, request, transport);
        return await router.handle(request);
      } catch (error) {
        return errorResponse(error, logger, request);
      }
    },
  };
}

function verifiedRequestBody(
  request: Request,
  server: unknown,
): HttpRequestTransportInfo | undefined {
  if (
    typeof server !== "object" ||
    server === null ||
    !("requestIP" in server) ||
    typeof server.requestIP !== "function"
  )
    return undefined;
  const transport = framedRequestBody(request);
  if (!transport) return undefined;
  // Bun returns null for Requests that did not originate from this server.
  // Only its native HTTP parser may vouch for Content-Length framing.
  if ((server as BunRequestServer).requestIP(request) == null) return undefined;
  return transport;
}
