import { HttpClientError } from "@typespex/http-client";
import { McpToolError } from "@typespex/mcp-server";

export function boundedInteger(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new McpToolError(`${name} must be an integer >= ${minimum}.`);
  return value;
}

export function upstreamRequestFailure(error: unknown): McpToolError {
  if (!(error instanceof HttpClientError)) {
    return error instanceof McpToolError
      ? error
      : new McpToolError("Upstream request failed.", { cause: error });
  }
  const message =
    error.code === "timeout"
      ? "Upstream request timed out."
      : error.code === "cancelled"
        ? "Upstream request was cancelled."
        : error.message.replace(/^HTTP /, "Upstream ");
  return new McpToolError(message, { cause: error });
}
