import type { DecoratorContext, Namespace, Operation, Program } from "@typespec/compiler";
import { createStateSymbol } from "./lib.js";
import type {
  McpServerMetadata,
  McpServerOptions,
  McpToolMetadata,
  McpToolOptions,
} from "./types.js";

const serverState = createStateSymbol("mcpServer");
const toolState = createStateSymbol("tool");

export function $mcpServer(
  context: DecoratorContext,
  target: Namespace,
  options: McpServerOptions,
): void {
  context.program.stateMap(serverState).set(target, { ...options, namespace: target });
}

export function $tool(
  context: DecoratorContext,
  target: Operation,
  options: McpToolOptions = {},
): void {
  context.program.stateMap(toolState).set(target, { ...options, operation: target });
}

export function listMcpServers(program: Program): McpServerMetadata[] {
  return [...program.stateMap(serverState).values()] as McpServerMetadata[];
}

export function listMcpTools(program: Program): McpToolMetadata[] {
  return [...program.stateMap(toolState).values()] as McpToolMetadata[];
}

export function getMcpServer(
  program: Program,
  namespace: Namespace,
): McpServerMetadata | undefined {
  return program.stateMap(serverState).get(namespace) as McpServerMetadata | undefined;
}

export function getMcpTool(program: Program, operation: Operation): McpToolMetadata | undefined {
  return program.stateMap(toolState).get(operation) as McpToolMetadata | undefined;
}
