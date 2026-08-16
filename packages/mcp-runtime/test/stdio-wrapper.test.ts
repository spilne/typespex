import { expect, mock, test } from "bun:test";
import type { McpServerFactory } from "@modelcontextprotocol/server";

let receivedOptions: Record<string, unknown> | undefined;
const handle = { close: async () => undefined };

mock.module("@modelcontextprotocol/server/stdio", () => ({
  serveStdio(_factory: McpServerFactory, options: Record<string, unknown>) {
    receivedOptions = options;
    return handle;
  },
}));

test("stdio wrapper delegates options and keeps diagnostics on stderr", async () => {
  const { serveTypespexStdio } = await import("../src/stdio.js");
  const onError = () => undefined;
  expect(
    serveTypespexStdio((() => undefined) as unknown as McpServerFactory, {
      legacy: "reject",
      onError,
    }),
  ).toBe(handle);
  expect(receivedOptions).toEqual({ legacy: "reject", onerror: onError });

  serveTypespexStdio((() => undefined) as unknown as McpServerFactory);
  expect(receivedOptions?.onerror).toBeFunction();
});
