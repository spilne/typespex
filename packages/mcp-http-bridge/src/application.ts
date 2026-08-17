import {
  McpToolError,
  mcpSuccess,
  type McpToolDefinition,
  type McpToolContext,
} from "@typespex/mcp-server";
import {
  mcpWireError,
  mcpWireSuccess,
  type ExecutableMcpApplication,
} from "@typespex/mcp-server/internal";
import type {
  HttpBridgeOperation,
  McpHttpBridgeApplication,
  McpHttpBridgeOptions,
} from "./contracts.js";
import { executeHttpBridgeTool } from "./execute.js";

/** Converts a public HTTP bridge configuration into the server core's executor seam. */
export function createMcpHttpBridgeApplication(
  operations: Readonly<Record<string, HttpBridgeOperation>>,
  application: McpHttpBridgeApplication,
): ExecutableMcpApplication {
  return {
    kind: "executor",
    ...(application.middleware ? { middleware: application.middleware } : {}),
    ...(application.createContext ? { createContext: application.createContext } : {}),
    ...(application.onUnhandledError ? { onUnhandledError: application.onUnhandledError } : {}),
    executor: {
      input: "wire",
      async execute(tool, input, context): Promise<unknown> {
        const operation = operations[tool.name];
        if (!operation) {
          throw new McpToolError(`Tool ${tool.name} has no generated HTTP bridge operation.`);
        }
        return executeBridgeResult(tool, operation, input, context, application.bridge);
      },
    },
  };
}

async function executeBridgeResult(
  tool: McpToolDefinition,
  operation: HttpBridgeOperation,
  input: unknown,
  context: McpToolContext,
  options: McpHttpBridgeOptions,
): Promise<unknown> {
  const result = await executeHttpBridgeTool(operation, input, context, options);
  if (result.kind === "success") {
    if (tool.voidResult && result.value === undefined) return mcpSuccess(undefined);
    if (!tool.success) {
      throw new McpToolError(`Upstream returned a body for void tool ${tool.name}.`);
    }
    return mcpWireSuccess(result.value);
  }
  if (!tool.errors) {
    throw new McpToolError(
      `Upstream returned modeled HTTP error ${result.status} for ${tool.name}.`,
    );
  }
  return mcpWireError(result.value);
}
