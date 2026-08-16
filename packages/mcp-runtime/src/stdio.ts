import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { McpServerFactory } from "@modelcontextprotocol/server";
import type { McpStdioOptions } from "./application.js";

/** Starts an MCP server without writing diagnostics to stdout. */
export function serveTypespexStdio(
  factory: McpServerFactory,
  options: McpStdioOptions = {},
): StdioServerHandle {
  return serveStdio(factory, {
    legacy: options.legacy,
    onerror: options.onError ?? ((error) => console.error(error)),
  });
}
