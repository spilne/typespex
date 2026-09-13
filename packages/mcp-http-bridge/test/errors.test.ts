import { describe, expect, test } from "bun:test";
import { HttpClientError, type HttpClientErrorCode } from "@typespex/http-client";
import { McpToolError } from "@typespex/mcp-server";
import { upstreamRequestFailure } from "../src/errors.js";

describe("upstream error translation", () => {
  const cases = [
    ["invalid-url", "Upstream request or redirect URL is invalid."],
    ["cancelled", "Upstream request was cancelled."],
    ["timeout", "Upstream request timed out."],
    ["network", "Upstream request failed."],
    ["redirect-limit", "Upstream redirect limit exceeded."],
    ["redirect-body", "Cannot replay a streaming HTTP request body across a redirect."],
    ["redirect-origin", "Upstream redirect origin is not allowed."],
    ["redirect-scheme", "Upstream redirect must use HTTP or HTTPS."],
    ["body-limit", "Upstream response exceeded the configured byte limit."],
    ["jsonl-item-limit", "Upstream JSONL response exceeded the configured item limit."],
    ["invalid-jsonl", "Upstream response contained invalid JSONL."],
  ] as const satisfies readonly (readonly [HttpClientErrorCode, string])[];

  for (const [code, message] of cases) {
    test(`selects ${code} diagnostics independently of client wording`, () => {
      for (const detail of ["HTTP original detail", "Changed wording with a private token"]) {
        const cause = new HttpClientError(code, detail);
        const error = upstreamRequestFailure(cause);
        expect(error).toBeInstanceOf(McpToolError);
        expect(error.message).toBe(message);
        expect(error.cause).toBe(cause);
      }
    });
  }

  test("preserves existing tool errors", () => {
    const error = new McpToolError("A modeled operational failure.", {
      cause: new Error("Internal detail"),
    });
    expect(upstreamRequestFailure(error)).toBe(error);
  });

  test("keeps unexpected failures private while retaining their cause", () => {
    for (const cause of [new Error("secret"), "secret", undefined, { code: "timeout" }]) {
      const error = upstreamRequestFailure(cause);
      expect(error.message).toBe("Upstream request failed.");
      expect(error.cause).toBe(cause);
    }
  });

  test("handles unknown client codes without exposing their messages or inherited properties", () => {
    for (const code of ["future-code", "__proto__", "constructor", "toString"]) {
      const cause = new HttpClientError(code as HttpClientErrorCode, "Private client detail");
      const error = upstreamRequestFailure(cause);
      expect(error.message).toBe("Upstream request failed.");
      expect(error.cause).toBe(cause);
    }
  });
});
