import type { CallToolResult } from "@modelcontextprotocol/server";

const RESULT_TAG = Symbol.for("@typespex/mcp-server/result");
const TOOL_ERROR_TAG = Symbol.for("@typespex/mcp-server/tool-error");

export type McpContent = CallToolResult["content"];

export interface McpToolResult<Success, Error = never> {
  readonly [RESULT_TAG]: true;
  readonly kind: "success" | "error";
  readonly value: Success | Error;
  readonly content?: McpContent;
}

export function mcpSuccess<Success>(
  value: Success,
  options: { readonly content?: McpContent } = {},
): McpToolResult<Success, never> {
  return { [RESULT_TAG]: true, kind: "success", value, ...options };
}

export function mcpError<Error>(
  value: Error,
  options: { readonly content?: McpContent } = {},
): McpToolResult<never, Error> {
  return { [RESULT_TAG]: true, kind: "error", value, ...options };
}

export function isMcpToolResult(value: unknown): value is McpToolResult<unknown, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    RESULT_TAG in value &&
    (value as { [RESULT_TAG]?: unknown })[RESULT_TAG] === true,
  );
}

export class McpToolError extends Error {
  constructor(
    message: string,
    readonly options: { readonly content?: McpContent; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "McpToolError";
    Object.defineProperty(this, TOOL_ERROR_TAG, { value: true });
  }
}

/** Recognizes operational errors across duplicate module instances. */
export function isMcpToolError(value: unknown): value is McpToolError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<PropertyKey, unknown>;
  return (
    candidate[TOOL_ERROR_TAG] === true &&
    typeof candidate.message === "string" &&
    typeof candidate.options === "object" &&
    candidate.options !== null
  );
}
