import type { Serve, Server } from "bun";
import { consoleLogger, handleRequestWithTransport, type HttpRouter } from "@typespex/http-server";
import type { BunHandlerOptions } from "./index.js";
import { createNativeRoutes } from "./native-routes.js";
import { errorResponse } from "./error-response.js";
import { framedRequestBody } from "./transport.js";

/** Listening and TLS options for a standalone Bun HTTP server. */
export interface BunServerOptions
  extends
    BunHandlerOptions,
    Pick<
      Serve.HostnamePortServeOptions<undefined>,
      "port" | "hostname" | "reusePort" | "ipv6Only" | "idleTimeout" | "tls" | "maxRequestBodySize"
    > {}

/** Server lifecycle and connection information; request dispatch stays private. */
export interface BunHttpServer extends Pick<
  Server<undefined>,
  | "port"
  | "hostname"
  | "url"
  | "pendingRequests"
  | "stop"
  | "ref"
  | "unref"
  | "requestIP"
  | "timeout"
> {}

/**
 * Starts a standalone HTTP server with Bun's native route dispatch when the
 * router's patterns permit it. Middleware, validation, and body limits still
 * run through the router. Other patterns and custom routers use its normal dispatch.
 *
 * The returned lifecycle handle deliberately keeps Bun's synthetic fetch and
 * reload entry points private, so these callbacks only receive native requests.
 */
export function createBunServer(router: HttpRouter, options: BunServerOptions = {}): BunHttpServer {
  const logger = options.logger ?? consoleLogger;
  const handle = (request: Request): Promise<Response> => {
    const transport = framedRequestBody(request);
    return transport
      ? handleRequestWithTransport(router, request, transport)
      : router.handle(request);
  };
  const server = Bun.serve({
    port: options.port,
    hostname: options.hostname,
    reusePort: options.reusePort,
    ipv6Only: options.ipv6Only,
    idleTimeout: options.idleTimeout,
    tls: options.tls,
    maxRequestBodySize: options.maxRequestBodySize,
    development: false,
    id: null,
    routes: createNativeRoutes(router, handle),
    error: (error) => errorResponse(error, logger),
    fetch: handle,
  });
  return {
    get port() {
      return server.port;
    },
    get hostname() {
      return server.hostname;
    },
    get url() {
      return server.url;
    },
    get pendingRequests() {
      return server.pendingRequests;
    },
    stop(closeActiveConnections) {
      return server.stop(closeActiveConnections);
    },
    ref() {
      server.ref();
    },
    unref() {
      server.unref();
    },
    requestIP(request) {
      return server.requestIP(request);
    },
    timeout(request, seconds) {
      server.timeout(request, seconds);
    },
  };
}
