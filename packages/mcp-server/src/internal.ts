/**
 * Internal integration surface for TypeSpex protocol bridges.
 *
 * This subpath is not intended for application authors and may change between
 * minor releases.
 */
export {
  mcpWireError,
  mcpWireSuccess,
  type ExecutableMcpApplication,
  type McpServerApplication,
  type McpToolExecutor,
  type McpWireToolResult,
} from "./server.js";
