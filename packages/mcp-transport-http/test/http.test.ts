import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { toBunHandler } from "@typespex/adapter-bun";
import { toExpressHandler } from "@typespex/adapter-express";
import { toHonoApp } from "@typespex/adapter-hono";
import { toNodeHandler } from "@typespex/adapter-node";
import {
  createGeneratedMcpServer,
  createTypeSpecSchema,
  type GeneratedMcpTool,
  type NativeMcpApplication,
} from "@typespex/mcp-server";
import express from "express";
import {
  createTypespexHttpHandler,
  isLoopbackHost,
  resolveMcpHttpServerOptions,
} from "../src/index.js";

interface BunServerHandle {
  readonly port: number;
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

const clients: Client[] = [];
const nodeServers: Server[] = [];
const bunServers: BunServerHandle[] = [];
const handlers: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    nodeServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(bunServers.splice(0).map((server) => server.stop(true)));
  await Promise.all(handlers.splice(0).map((handler) => handler.close()));
});

describe("MCP Streamable HTTP transport", () => {
  test("serves through the standalone Node adapter", async () => {
    const handler = trackedHandler();
    const server = createServer(toNodeHandler({ handle: handler.fetch }));
    await listen(server);
    nodeServers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address.");
    const client = await connect(new URL(`http://127.0.0.1:${address.port}/mcp`));
    expect(await callEcho(client, "node")).toEqual({ value: "node" });
  });

  test("mounts through the Express adapter without installing Hono at runtime", async () => {
    const handler = trackedHandler();
    const app = express();
    app.use(toExpressHandler({ handle: handler.fetch }));
    const server = createServer(app);
    await listen(server);
    nodeServers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address.");
    const client = await connect(new URL(`http://127.0.0.1:${address.port}/mcp`), "legacy");
    expect(await callEcho(client, "express")).toEqual({ value: "express" });
  });

  test("mounts through the Hono adapter", async () => {
    const handler = trackedHandler();
    const app = toHonoApp({ handle: handler.fetch });
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

  test("serves through the Bun adapter", async () => {
    const handler = trackedHandler();
    const adapter = toBunHandler({ handle: handler.fetch });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: adapter.fetch });
    bunServers.push(server);
    const client = await connect(new URL(`http://127.0.0.1:${server.port}/mcp`));
    expect(await callEcho(client, "bun")).toEqual({ value: "bun" });
  });

  test("defaults to loopback and requires explicit security for non-loopback exposure", () => {
    expect(resolveMcpHttpServerOptions()).toMatchObject({
      host: "127.0.0.1",
      port: 3000,
      path: "/mcp",
      requiresAuth: false,
    });
    expect(() => resolveMcpHttpServerOptions({ host: "0.0.0.0" })).toThrow(
      "Non-loopback MCP HTTP servers require allowedHosts, allowedOrigins, and verifyAuth",
    );
    expect(
      resolveMcpHttpServerOptions({
        host: "0.0.0.0",
        allowedHosts: ["mcp.example.test"],
        allowedOrigins: ["https://client.example.test"],
        verifyAuth: () => undefined,
      }),
    ).toMatchObject({ requiresAuth: true });
  });

  test("normalizes safe HTTP configuration and rejects malformed values", () => {
    expect(
      resolveMcpHttpServerOptions({
        host: " [::1] ",
        port: 0,
        path: `/custom${"/".repeat(10_000)}`,
        allowedHosts: ["http://localhost:3000"],
        allowedOrigins: ["http://127.0.0.1:3000"],
        legacy: "reject",
        responseMode: "json",
      }),
    ).toMatchObject({
      host: "[::1]",
      port: 0,
      path: "/custom",
      allowedHosts: ["localhost"],
      allowedOrigins: ["http://127.0.0.1:3000"],
      legacy: "reject",
      responseMode: "json",
    });

    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::ffff:127.0.0.42]")).toBe(true);
    expect(isLoopbackHost("192.0.2.1")).toBe(false);

    for (const port of [-1, 1.5, 65_536]) {
      expect(() => resolveMcpHttpServerOptions({ port })).toThrow("Invalid MCP HTTP port");
    }
    for (const host of ["", "example.test/path", "user@example.test"]) {
      expect(() => resolveMcpHttpServerOptions({ host })).toThrow("Invalid MCP HTTP host");
    }
    for (const path of ["mcp", "/mcp?debug", "/mcp#fragment"]) {
      expect(() => resolveMcpHttpServerOptions({ path })).toThrow("Invalid MCP HTTP path");
    }
    expect(() => resolveMcpHttpServerOptions({ allowedHosts: [" "] })).toThrow(
      "allowlists cannot contain empty",
    );
    expect(() => resolveMcpHttpServerOptions({ allowedHosts: ["http://["] })).toThrow(
      "Invalid MCP HTTP allowlist hostname",
    );
    expect(() => resolveMcpHttpServerOptions({ allowedOrigins: [" "] })).toThrow(
      "origin allowlists cannot contain empty",
    );
    for (const origin of [
      "not-an-origin",
      "ftp://localhost",
      "http://user@localhost",
      "http://localhost/path",
      "http://localhost?query",
      "http://localhost#fragment",
    ]) {
      expect(() => resolveMcpHttpServerOptions({ allowedOrigins: [origin] })).toThrow(
        "Invalid MCP HTTP origin",
      );
    }
  });

  test("rejects invalid paths, hosts, and origins before protocol handling", async () => {
    const handler = trackedHandler();
    expect(
      await handler.fetch(new Request("http://127.0.0.1:3000/not-mcp", { method: "POST" })),
    ).toMatchObject({ status: 404 });
    expect(
      await handler.fetch(
        new Request("http://attacker.example:3000/mcp", {
          method: "POST",
          headers: { host: "attacker.example" },
        }),
      ),
    ).toMatchObject({ status: 403 });
    expect(
      await handler.fetch(
        new Request("http://127.0.0.1:3000/mcp", {
          method: "POST",
          headers: { host: "127.0.0.1:3000", origin: "https://attacker.example" },
        }),
      ),
    ).toMatchObject({ status: 403 });
  });

  test("enforces exact Origin allowlists", async () => {
    const handler = createTypespexHttpHandler(factory, {
      allowedOrigins: ["http://127.0.0.1:3000"],
    });
    handlers.push(handler);

    for (const origin of [
      "not an origin",
      "ftp://127.0.0.1",
      "http://user@127.0.0.1",
      "http://127.0.0.1:3000/path",
      "http://127.0.0.1:3000?query",
      "http://127.0.0.1:3000#fragment",
      "http://127.0.0.1:4000",
    ]) {
      const response = await handler.fetch(protocolRequest({ origin }));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        jsonrpc: "2.0",
        error: { code: -32_000, message: `Invalid Origin: ${origin}` },
      });
    }
  });

  test("applies inbound authentication before protocol handling", async () => {
    const verified = {
      token: "secret",
      clientId: "client",
      scopes: ["tools:call"],
      extra: { tenant: "one" },
    };
    const handler = createTypespexHttpHandler(factory, {
      host: "0.0.0.0",
      allowedHosts: ["api.example.test"],
      allowedOrigins: ["https://client.example.test"],
      verifyAuth: () => verified,
    });
    handlers.push(handler);

    const response = await handler.fetch(
      protocolRequest({ host: "api.example.test", origin: "https://client.example.test" }),
    );
    expect(response.status).not.toBe(401);
  });

  test("supports verifier responses and sanitizes verifier failures", async () => {
    const denied = createTypespexHttpHandler(factory, {
      host: "0.0.0.0",
      allowedHosts: ["api.example.test"],
      allowedOrigins: ["https://client.example.test"],
      verifyAuth: () => new Response("Denied.", { status: 403 }),
    });
    handlers.push(denied);
    const requestOptions = { host: "api.example.test", origin: "https://client.example.test" };
    expect(await denied.fetch(protocolRequest(requestOptions))).toMatchObject({ status: 403 });

    const errors: Error[] = [];
    const failed = createTypespexHttpHandler(factory, {
      host: "0.0.0.0",
      allowedHosts: ["api.example.test"],
      allowedOrigins: ["https://client.example.test"],
      verifyAuth: () => {
        throw "credential backend unavailable";
      },
      onError: (error) => errors.push(error),
    });
    handlers.push(failed);
    const response = await failed.fetch(protocolRequest(requestOptions));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(errors.map((error) => error.message)).toEqual(["credential backend unavailable"]);

    const missing = createTypespexHttpHandler(factory, {
      host: "0.0.0.0",
      allowedHosts: ["api.example.test"],
      allowedOrigins: ["https://client.example.test"],
      verifyAuth: () => undefined,
    });
    handlers.push(missing);
    expect(await missing.fetch(protocolRequest(requestOptions))).toMatchObject({ status: 401 });
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

function trackedHandler() {
  const handler = createTypespexHttpHandler(factory);
  handlers.push(handler);
  return handler;
}

function protocolRequest({
  host = "127.0.0.1:3000",
  origin,
}: {
  readonly host?: string;
  readonly origin?: string;
} = {}): Request {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    host,
  });
  if (origin !== undefined) headers.set("origin", origin);
  return new Request(`http://${host}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2026-07-28",
        capabilities: {},
        clientInfo: { name: "transport-test", version: "1.0.0" },
      },
    }),
  });
}

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
