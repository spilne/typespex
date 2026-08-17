import { McpToolError } from "@typespex/mcp-server";

const HTTP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const UNSAFE_HTTP_HEADER_VALUE = /[\u0000-\u0008\u000a-\u001f\u007f]/;

export function assertSafeHeaderValue(value: string): void {
  if (UNSAFE_HTTP_HEADER_VALUE.test(value)) {
    throw new McpToolError("Rejected invalid HTTP header value.");
  }
}

export function setSafeHeader(headers: Headers, name: string, value: string): void {
  if (!HTTP_HEADER_NAME.test(name)) {
    throw new McpToolError("Rejected invalid HTTP header value.");
  }
  assertSafeHeaderValue(value);
  try {
    headers.set(name, value);
  } catch (error) {
    throw new McpToolError("Rejected invalid HTTP header value.", { cause: error });
  }
}
