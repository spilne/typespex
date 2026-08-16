import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

describe("stdio transport", () => {
  test("keeps stdout protocol-clean in a real child process", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(import.meta.dir, "fixtures/stdio-server.ts")],
      cwd: resolve(import.meta.dir, "../../.."),
      stderr: "pipe",
    });
    const client = new Client(
      { name: "stdio-client", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    try {
      await client.connect(transport);
      await client.listTools();
      const result = await client.callTool({ name: "echo", arguments: { value: "stdio" } });
      expect(result.structuredContent).toEqual({ value: "stdio" });
    } finally {
      await client.close();
    }
  });
});
