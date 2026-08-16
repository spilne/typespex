import { describe, expect, test } from "bun:test";
import type { McpToolContext } from "@typespex/mcp-runtime";
import { executeHttpBridgeTool } from "@typespex/mcp-runtime/http-bridge";
import { mcpHttpBridgeOperations } from "./generated-mcp/pet-assistant/mcp-http-client.js";

const context = {
  requestId: "generated-bridge-test",
  signal: new AbortController().signal,
} as McpToolContext;

describe("generated MCP HTTP bridge", () => {
  test("executes an emitter-produced operation descriptor", async () => {
    let request: Request | undefined;
    const result = await executeHttpBridgeTool(
      mcpHttpBridgeOperations.getPet,
      { id: "a/b" },
      context,
      {
        fetch: (async (input, init) => {
          request = new Request(input, init);
          return Response.json({ id: "a/b", name: "Poppy" });
        }) as typeof fetch,
      },
    );

    expect(request?.url).toBe("https://pets.example.test/pets/a%2Fb");
    expect(result).toEqual({
      kind: "success",
      status: 200,
      value: { id: "a/b", name: "Poppy" },
    });
  });
});
