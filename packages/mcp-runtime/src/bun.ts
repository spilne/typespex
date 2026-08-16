import type { McpServerFactory } from "@modelcontextprotocol/server";
import {
  createTypespexHttpHandler,
  resolveMcpHttpServerOptions,
  type McpHttpServerOptions,
} from "./http.js";

export interface BunServerHandle {
  readonly port?: number;
  readonly hostname?: string;
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

interface BunRuntime {
  serve(options: {
    hostname: string;
    port: number;
    fetch(request: Request): Response | Promise<Response>;
    error?(error: Error): Response | Promise<Response>;
  }): BunServerHandle;
}

export function runTypespexBunServer(
  factory: McpServerFactory,
  options: McpHttpServerOptions = {},
): BunServerHandle {
  const bun = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
  if (!bun) throw new Error("runTypespexBunServer() must be called from Bun.");
  const resolved = resolveMcpHttpServerOptions(options);
  const handler = createTypespexHttpHandler(factory, options);
  const server = bun.serve({
    hostname: resolved.host,
    port: resolved.port,
    fetch: handler.fetch,
    error(error) {
      resolved.onError?.(error);
      return new Response("Internal server error.", { status: 500 });
    },
  });
  let closed = false;
  return {
    get port() {
      return server.port;
    },
    get hostname() {
      return server.hostname;
    },
    async stop(closeActiveConnections) {
      try {
        await server.stop(closeActiveConnections);
      } finally {
        if (!closed) {
          closed = true;
          await handler.close();
        }
      }
    },
  };
}

export type { McpHttpServerOptions } from "./http.js";
