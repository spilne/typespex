import { HttpClientError, type HttpClientErrorCode } from "@typespex/http-client";
import { McpToolError } from "@typespex/mcp-server";

// Presentation belongs to the bridge. HTTP-client messages remain available
// through cause, but are neither parsed nor exposed as tool diagnostics.
const upstreamMessages = {
  "invalid-url": "Upstream request or redirect URL is invalid.",
  cancelled: "Upstream request was cancelled.",
  timeout: "Upstream request timed out.",
  network: "Upstream request failed.",
  "redirect-limit": "Upstream redirect limit exceeded.",
  "redirect-body": "Cannot replay a streaming HTTP request body across a redirect.",
  "redirect-origin": "Upstream redirect origin is not allowed.",
  "redirect-scheme": "Upstream redirect must use HTTP or HTTPS.",
  "body-limit": "Upstream response exceeded the configured byte limit.",
  "jsonl-item-limit": "Upstream JSONL response exceeded the configured item limit.",
  "invalid-jsonl": "Upstream response contained invalid JSONL.",
} satisfies Record<HttpClientErrorCode, string>;

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
  const message = Object.hasOwn(upstreamMessages, error.code)
    ? upstreamMessages[error.code]
    : "Upstream request failed.";
  return new McpToolError(message, { cause: error });
}
