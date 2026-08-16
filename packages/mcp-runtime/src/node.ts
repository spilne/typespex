import { createServer, type Server } from "node:http";
import { toNodeHandler, type NodeMcpRequestHandler } from "@modelcontextprotocol/node";
import type { McpServerFactory } from "@modelcontextprotocol/server";
import {
  createTypespexHttpHandler,
  resolveMcpHttpServerOptions,
  type McpHttpServerOptions,
} from "./http.js";

export function createTypespexNodeHandler(
  factory: McpServerFactory,
  options: McpHttpServerOptions = {},
): NodeMcpRequestHandler {
  const handler = createTypespexHttpHandler(factory, options);
  return toNodeHandler(handler, { onerror: options.onError });
}

export async function runTypespexNodeServer(
  factory: McpServerFactory,
  options: McpHttpServerOptions = {},
): Promise<Server> {
  const resolved = resolveMcpHttpServerOptions(options);
  const handler = createTypespexHttpHandler(factory, options);
  const nodeHandler = toNodeHandler(handler, { onerror: resolved.onError });
  const server = createServer((request, response) => {
    void nodeHandler(request, response);
  });
  server.on("close", () => void handler.close());

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(resolved.port, resolved.host);
  });
  return server;
}

export type { McpHttpServerOptions } from "./http.js";
