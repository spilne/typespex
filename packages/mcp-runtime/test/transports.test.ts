import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import express from "express";
import { Hono } from "hono";
import {
  createGeneratedMcpServer,
  createTypeSpecSchema,
  type GeneratedMcpTool,
  type NativeMcpApplication,
} from "../src/index.js";
import { runTypespexBunServer, type BunServerHandle } from "../src/bun.js";
import { createTypespexHonoHandler } from "../src/hono.js";
import * as httpRuntime from "../src/http.js";
import { createTypespexHttpHandler, resolveMcpHttpServerOptions } from "../src/http.js";
import { createTypespexNodeHandler, runTypespexNodeServer } from "../src/node.js";

const clients: Client[] = [];
const nodeServers: Server[] = [];
const bunServers: BunServerHandle[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    nodeServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(bunServers.splice(0).map((server) => server.stop(true)));
});

describe("MCP transports", () => {
  test("serves Streamable HTTP from standalone Node", async () => {
    const server = await runTypespexNodeServer(factory, { port: 0 });
    nodeServers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address.");
    const client = await connect(new URL(`http://127.0.0.1:${address.port}/mcp`));
    expect(await callEcho(client, "node")).toEqual({ value: "node" });
  });

  test("mounts in a real Express application", async () => {
    const handler = createTypespexNodeHandler(factory);
    const app = express();
    app.use((request, response) => void handler(request, response));
    const server = createServer(app);
    await listen(server);
    nodeServers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address.");
    const client = await connect(new URL(`http://127.0.0.1:${address.port}/mcp`), "legacy");
    expect(await callEcho(client, "express")).toEqual({ value: "express" });
  });

  test("mounts in a real Hono application", async () => {
    const hono = createTypespexHonoHandler(factory);
    const app = new Hono();
    app.all("/mcp", (context) => hono(context));
    const client = await connect(
      new URL("http://127.0.0.1:3000/mcp"),
      "auto",
      async (input, init) => {
        const request = new Request(input, init);
        const headers = new Headers(request.headers);
        headers.set("host", "127.0.0.1:3000");
        return app.fetch(new Request(request, { headers }));
      },
    );
    expect(await callEcho(client, "hono")).toEqual({ value: "hono" });
  });

  test("serves Streamable HTTP from Bun", async () => {
    const server = runTypespexBunServer(factory, { port: 0 });
    bunServers.push(server);
    if (server.port === undefined) throw new Error("Bun did not expose its bound port.");
    const client = await connect(new URL(`http://127.0.0.1:${server.port}/mcp`));
    expect(await callEcho(client, "bun")).toEqual({ value: "bun" });
  });

  test("closes Bun MCP sessions exactly once when the listener stops", async () => {
    const close = mock(async () => undefined);
    const handler = {
      fetch: () => new Response(null, { status: 204 }),
      close,
    } as ReturnType<typeof createTypespexHttpHandler>;
    const createHandler = spyOn(httpRuntime, "createTypespexHttpHandler").mockReturnValue(handler);
    try {
      const server = runTypespexBunServer(factory, { port: 0 });
      expect(server.port).toBeDefined();
      expect(server.hostname).toBe("127.0.0.1");
      await server.stop(true);
      await server.stop(true);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      createHandler.mockRestore();
    }
  });

  test("rejects unsafe non-loopback startup and invalid Host or Origin", async () => {
    expect(() => resolveMcpHttpServerOptions({ host: "0.0.0.0" })).toThrow(
      "require allowedHosts, allowedOrigins, and verifyAuth",
    );
    const handler = createTypespexHttpHandler(factory);
    const badHost = await handler.fetch(
      new Request("http://127.0.0.1:3000/mcp", { headers: { host: "attacker.test" } }),
    );
    expect(badHost.status).toBe(403);
    const badOrigin = await handler.fetch(
      new Request("http://127.0.0.1:3000/mcp", {
        headers: { host: "127.0.0.1:3000", origin: "https://attacker.test" },
      }),
    );
    expect(badOrigin.status).toBe(403);
    await handler.close();

    expect(() =>
      resolveMcpHttpServerOptions({
        allowedHosts: ["api.example.test"],
        allowedOrigins: ["https://app.example.test"],
      }),
    ).toThrow("require allowedHosts, allowedOrigins, and verifyAuth");

    const mounted = createTypespexHttpHandler(factory, {
      allowedHosts: ["api.example.test"],
      allowedOrigins: ["https://app.example.test"],
      verifyAuth: () => undefined,
    });
    const unauthenticated = await mounted.fetch(
      new Request("https://api.example.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "api.example.test",
          origin: "https://app.example.test",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }),
    );
    expect(unauthenticated.status).toBe(401);
    await mounted.close();

    const secured = resolveMcpHttpServerOptions({
      host: "0.0.0.0",
      allowedHosts: ["api.example.test:8443"],
      allowedOrigins: ["https://app.example.test:444"],
      verifyAuth: () => ({ token: "verified", clientId: "test", scopes: [] }),
    });
    expect(secured.allowedHosts).toEqual(["api.example.test"]);
    expect(secured.allowedOrigins).toEqual(["https://app.example.test:444"]);
    expect(secured.requiresAuth).toBe(true);
    expect(resolveMcpHttpServerOptions().requiresAuth).toBe(false);

    const exactOrigin = createTypespexHttpHandler(factory, {
      host: "0.0.0.0",
      allowedHosts: ["api.example.test"],
      allowedOrigins: ["https://app.example.test:444"],
      verifyAuth: () => ({ token: "verified", clientId: "test", scopes: [] }),
    });
    const emptyOrigin = await exactOrigin.fetch(
      new Request("https://api.example.test/mcp", {
        headers: { host: "api.example.test", origin: "" },
      }),
    );
    expect(emptyOrigin.status).not.toBe(403);
    for (const origin of [
      "http://app.example.test:444",
      "https://app.example.test:445",
      "https://app.example.test:444/path",
    ]) {
      const rejected = await exactOrigin.fetch(
        new Request("https://api.example.test/mcp", {
          headers: { host: "api.example.test", origin },
        }),
      );
      expect(rejected.status).toBe(403);
      expect(rejected.headers.get("content-type")).toContain("application/json");
      expect(await rejected.json()).toEqual({
        jsonrpc: "2.0",
        error: { code: -32_000, message: `Invalid Origin: ${origin}` },
        id: null,
      });
    }
    await exactOrigin.close();
  });
});

const schema = createTypeSpecSchema<{ value: string }>({
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  codec: {
    root: {
      kind: "object",
      properties: { value: { wireName: "value", codec: { kind: "identity" } } },
    },
  },
});

const tools: GeneratedMcpTool[] = [
  { name: "echo", handler: "echo", input: schema, success: schema },
];
const application: NativeMcpApplication<{ echo(input: { value: string }): { value: string } }> = {
  handlers: { echo: (input) => input },
};
const factory = () =>
  createGeneratedMcpServer(
    { implementation: { name: "transport-test", version: "1.0.0" } },
    tools,
    application,
  );

async function connect(
  url: URL,
  mode: "legacy" | "auto" = "auto",
  fetchImplementation?: typeof fetch,
): Promise<Client> {
  const client = new Client(
    { name: "transport-client", version: "1.0.0" },
    mode === "auto" ? { versionNegotiation: { mode: "auto" } } : undefined,
  );
  const transport = new StreamableHTTPClientTransport(url, {
    ...(fetchImplementation ? { fetch: fetchImplementation } : {}),
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function callEcho(client: Client, value: string): Promise<unknown> {
  await client.listTools();
  return (await client.callTool({ name: "echo", arguments: { value } })).structuredContent;
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}
