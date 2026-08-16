import { afterEach, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  createGeneratedMcpServer,
  createTypeSpecSchema,
  type GeneratedMcpTool,
} from "@typespex/mcp-server";
import {
  createHttpBridgeServerApplication,
  type HttpBridgeMcpApplication,
  type HttpBridgeOperation,
} from "../src/index.js";

const open: { client: Client; server: McpServer }[] = [];

afterEach(async () => {
  await Promise.all(
    open.splice(0).map(({ client, server }) => Promise.all([client.close(), server.close()])),
  );
});

describe("HTTP bridge application", () => {
  test("plugs modeled success, error, and void results into the server core", async () => {
    const schema = createTypeSpecSchema<{ value: string }>({
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    });
    const tools = [
      { name: "read", handler: "read", input: schema, success: schema, errors: schema },
      { name: "empty", handler: "empty", input: schema, voidResult: true },
    ] as const satisfies readonly GeneratedMcpTool[];
    const operations = {
      read: {
        version: 1,
        id: "read",
        method: "GET",
        path: "/values/{value}",
        parameters: [{ source: ["value"], name: "value", location: "path", required: true }],
        responses: [
          { statuses: [200], kind: "json" },
          { statuses: [404], kind: "json", error: true },
        ],
        servers: [{ url: "https://api.example.test", fullyDefaulted: true }],
      },
      empty: {
        version: 1,
        id: "empty",
        method: "POST",
        path: "/empty",
        responses: [{ statuses: [204], kind: "empty" }],
        servers: [{ url: "https://api.example.test", fullyDefaulted: true }],
      },
    } as const satisfies Readonly<Record<string, HttpBridgeOperation>>;
    const application: HttpBridgeMcpApplication = {
      kind: "http-bridge",
      bridge: {
        fetch: (async (input: RequestInfo | URL) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.pathname === "/empty") return new Response(null, { status: 204 });
          const value = url.pathname.split("/").at(-1)!;
          return Response.json({ value }, { status: value === "missing" ? 404 : 200 });
        }) as typeof fetch,
      },
    };
    const server = createGeneratedMcpServer(
      { implementation: { name: "bridge", version: "1.0.0" } },
      tools,
      createHttpBridgeServerApplication(operations, application),
    );
    const client = await connect(server);

    const success = await client.callTool({ name: "read", arguments: { value: "present" } });
    expect(success.structuredContent).toEqual({ value: "present" });
    const error = await client.callTool({ name: "read", arguments: { value: "missing" } });
    expect(error.isError).toBe(true);
    expect(error.structuredContent).toEqual({ value: "missing" });
    const empty = await client.callTool({ name: "empty", arguments: { value: "ignored" } });
    expect(empty).toMatchObject({ content: [] });
  });
});

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "bridge-test-client", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  await client.connect(clientTransport);
  open.push({ client, server });
  return client;
}
