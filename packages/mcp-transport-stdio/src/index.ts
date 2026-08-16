import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { McpServerFactory } from "@modelcontextprotocol/server";

export interface McpStdioOptions {
  readonly legacy?: "serve" | "reject";
  readonly onError?: (error: Error) => void;
}

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
