import type { McpServerFactory } from "@modelcontextprotocol/server";
import { createTypespexHttpHandler, type McpHttpServerOptions } from "./http.js";

export interface HonoMcpContext {
  readonly req: { readonly raw: Request };
}

export type HonoMcpHandler = (context: HonoMcpContext) => Promise<Response>;

/** Framework-native Hono mount adapter without a hard dependency on Hono. */
export function createTypespexHonoHandler(
  factory: McpServerFactory,
  options: McpHttpServerOptions = {},
): HonoMcpHandler {
  const handler = createTypespexHttpHandler(factory, options);
  return (context) => handler.fetch(context.req.raw);
}

export type { McpHttpServerOptions } from "./http.js";
