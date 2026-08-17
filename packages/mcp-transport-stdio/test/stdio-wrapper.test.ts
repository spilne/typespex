import { expect, mock, spyOn, test } from "bun:test";
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
  const { serveMcpStdio } = await import("../src/index.js");
  const onError = () => undefined;
  expect(
    serveMcpStdio((() => undefined) as unknown as McpServerFactory, {
      legacy: "reject",
      onError,
    }),
  ).toBe(handle);
  expect(receivedOptions).toEqual({ legacy: "reject", onerror: onError });

  serveMcpStdio((() => undefined) as unknown as McpServerFactory);
  expect(receivedOptions?.onerror).toBeFunction();
  const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
  const error = new Error("stdio failure");
  (receivedOptions?.onerror as (error: unknown) => void)(error);
  expect(consoleError).toHaveBeenCalledWith(error);
  consoleError.mockRestore();
});
