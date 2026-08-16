import { afterEach, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  createGeneratedMcpServer,
  createTypeSpecSchema,
  defineMcpApplication,
  McpToolError,
  mcpError,
  mcpSuccess,
  type GeneratedMcpTool,
} from "../src/index.js";

const open: { client: Client; server: McpServer }[] = [];

afterEach(async () => {
  await Promise.all(
    open.splice(0).map(({ client, server }) => Promise.all([client.close(), server.close()])),
  );
});

describe("generated MCP server", () => {
  for (const negotiation of ["legacy", "auto"] as const) {
    test(`lists and calls typed tools over ${negotiation} protocol negotiation`, async () => {
      const input = createTypeSpecSchema<{ id: string }>({
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        codec: {
          root: {
            kind: "object",
            properties: { id: { wireName: "id", codec: { kind: "identity" } } },
          },
        },
      });
      const success = createTypeSpecSchema<{ id: string; name: string }>({
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { id: { type: "string" }, name: { type: "string" } },
          required: ["id", "name"],
          additionalProperties: false,
        },
        codec: {
          root: {
            kind: "object",
            properties: {
              id: { wireName: "id", codec: { kind: "identity" } },
              name: { wireName: "name", codec: { kind: "identity" } },
            },
          },
        },
      });
      const errors = createTypeSpecSchema<{ code: "not-found"; message: string }>({
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            code: { type: "string", const: "not-found" },
            message: { type: "string" },
          },
          required: ["code", "message"],
          additionalProperties: false,
        },
        codec: {
          root: {
            kind: "object",
            properties: {
              code: { wireName: "code", codec: { kind: "identity" } },
              message: { wireName: "message", codec: { kind: "identity" } },
            },
          },
        },
      });
      let requestId: string | number | undefined;
      const tools: GeneratedMcpTool[] = [
        {
          name: "getPet",
          handler: "getPet",
          title: "Get pet",
          input,
          success,
          errors,
        },
        {
          name: "explode",
          handler: "explode",
          input,
          success,
        },
        {
          name: "operational",
          handler: "operational",
          input,
          success,
        },
      ];
      const server = createGeneratedMcpServer(
        { implementation: { name: "test", version: "1.0.0" } },
        tools,
        {
          handlers: {
            getPet(value: { id: string }, context) {
              requestId = context.requestId;
              return value.id === "missing"
                ? mcpError({ code: "not-found" as const, message: "Missing" })
                : mcpSuccess(
                    { id: value.id, name: "Rex" },
                    { content: [{ type: "text", text: `pet:${value.id}` }] },
                  );
            },
            explode() {
              throw new Error("secret implementation detail");
            },
            operational() {
              return new McpToolError("Expected operational failure");
            },
          },
        },
      );
      const client = await connect(server, negotiation);

      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["getPet", "explode", "operational"]);
      expect(listed.tools[0]?.title).toBe("Get pet");
      expect(listed.tools[0]?.outputSchema).toBeDefined();

      const result = await client.callTool({ name: "getPet", arguments: { id: "p1" } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ id: "p1", name: "Rex" });
      expect(result.content).toEqual([{ type: "text", text: "pet:p1" }]);
      expect(requestId).toBeDefined();

      const modeled = await client.callTool({ name: "getPet", arguments: { id: "missing" } });
      expect(modeled.isError).toBe(true);
      expect(modeled.structuredContent).toEqual({ code: "not-found", message: "Missing" });

      const unexpected = await client.callTool({ name: "explode", arguments: { id: "p1" } });
      expect(unexpected.isError).toBe(true);
      expect(JSON.stringify(unexpected)).not.toContain("secret implementation detail");
      expect(JSON.stringify(unexpected)).toContain("Internal tool error");

      const operational = await client.callTool({
        name: "operational",
        arguments: { id: "p1" },
      });
      expect(operational.isError).toBe(true);
      expect(JSON.stringify(operational)).toContain("Expected operational failure");
    });
  }

  test("rejects runtime ambiguity instead of guessing a result class", async () => {
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
    const server = createGeneratedMcpServer(
      { implementation: { name: "ambiguous", version: "1.0.0" } },
      [{ name: "ambiguous", handler: "ambiguous", input: schema, success: schema, errors: schema }],
      { handlers: { ambiguous: () => ({ value: "both" }) } },
    );
    const client = await connect(server, "legacy");
    const result = await client.callTool({ name: "ambiguous", arguments: { value: "input" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("matching both success and error schemas");
  });

  test("does not resolve native handlers through the prototype chain", async () => {
    const input = createTypeSpecSchema<Record<string, never>>({
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      codec: { root: { kind: "object", properties: {} } },
    });
    let inheritedCalls = 0;
    const handlers = Object.create({
      inherited() {
        inheritedCalls += 1;
      },
    }) as Record<string, never>;
    const server = createGeneratedMcpServer(
      { implementation: { name: "own-handlers", version: "1.0.0" } },
      [{ name: "safe-tool", handler: "inherited", input, voidResult: true }],
      { handlers },
    );
    const client = await connect(server, "legacy");
    const result = await client.callTool({ name: "safe-tool", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("No handler is configured");
    expect(inheritedCalls).toBe(0);
  });

  test("executes generated HTTP bridge tools, including modeled errors and void results", async () => {
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
    const bridge = {
      fetch: (async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/empty") return new Response(null, { status: 204 });
        const value = url.pathname.split("/").at(-1)!;
        return Response.json({ value }, { status: value === "missing" ? 404 : 200 });
      }) as typeof fetch,
    };
    const application = defineMcpApplication({ kind: "http-bridge" as const, bridge });
    const server = createGeneratedMcpServer(
      { implementation: { name: "bridge", version: "1.0.0" } },
      [
        {
          name: "read",
          handler: "read",
          input: schema,
          success: schema,
          errors: schema,
          http: {
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
        },
        {
          name: "empty",
          handler: "empty",
          input: schema,
          voidResult: true,
          http: {
            id: "empty",
            method: "POST",
            path: "/empty",
            responses: [{ statuses: [204], kind: "empty" }],
            servers: [{ url: "https://api.example.test", fullyDefaulted: true }],
          },
        },
      ],
      application,
    );
    const client = await connect(server, "auto");

    const success = await client.callTool({ name: "read", arguments: { value: "present" } });
    expect(success.structuredContent).toEqual({ value: "present" });
    const error = await client.callTool({ name: "read", arguments: { value: "missing" } });
    expect(error.isError).toBe(true);
    expect(error.structuredContent).toEqual({ value: "missing" });
    const empty = await client.callTool({ name: "empty", arguments: { value: "ignored" } });
    expect(empty).toMatchObject({ content: [] });
  });

  test("validates every native result form and middleware contract", async () => {
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
    const tool = (name: string, extras: Partial<GeneratedMcpTool> = {}): GeneratedMcpTool => ({
      name,
      handler: name,
      input: schema,
      ...extras,
    });
    const unhandled: string[] = [];
    const middlewareCalls: string[] = [];
    const server = createGeneratedMcpServer(
      {
        implementation: { name: "results", version: "1.0.0" },
        registerCapabilities: [(registered) => expect(registered).toBeDefined()],
      },
      [
        tool("void", { voidResult: true }),
        tool("badVoid"),
        tool("taggedVoid"),
        tool("taggedError"),
        tool("outside", { success: schema }),
        tool("badSuccess", { success: schema }),
        tool("badError", { errors: schema }),
        tool("invalidContent", { success: schema }),
        tool("duplicateNext", { success: schema }),
        tool("missing", { success: schema }),
      ],
      {
        createContext: async (context) => ({ ...context, requestMeta: { extended: true } }),
        middleware: [
          async (invocation, next) => {
            middlewareCalls.push(invocation.tool);
            const value = await next();
            if (invocation.tool === "duplicateNext") await next();
            return value;
          },
        ],
        onUnhandledError: (error, _context, name) => {
          unhandled.push(`${name}:${String(error)}`);
        },
        handlers: {
          void: () => undefined,
          badVoid: () => "unexpected",
          taggedVoid: () => mcpSuccess(undefined, { content: [{ type: "text", text: "done" }] }),
          taggedError: () => mcpError({ value: "failure" }),
          outside: () => ({ other: true }),
          badSuccess: () => mcpSuccess({ other: true }),
          badError: () => mcpError({ other: true }),
          invalidContent: () =>
            mcpSuccess({ value: "ok" }, { content: [{ type: "unsupported" }] as never }),
          duplicateNext: (_input: unknown, context) => {
            expect(context.requestMeta).toEqual({ extended: true });
            return { value: "ok" };
          },
        },
      },
    );
    const client = await connect(server, "legacy");
    const call = (name: string) => client.callTool({ name, arguments: { value: "input" } });

    expect(await call("void")).toMatchObject({ content: [] });
    expect(await call("taggedVoid")).toMatchObject({ content: [{ type: "text", text: "done" }] });
    for (const name of [
      "badVoid",
      "taggedError",
      "outside",
      "badSuccess",
      "badError",
      "invalidContent",
      "duplicateNext",
      "missing",
    ]) {
      expect((await call(name)).isError).toBe(true);
    }
    expect(middlewareCalls).toContain("void");
    expect(unhandled.some((message) => message.includes("duplicateNext"))).toBe(true);
  });
});

async function connect(server: McpServer, negotiation: "legacy" | "auto"): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    negotiation === "auto" ? { versionNegotiation: { mode: "auto" } } : undefined,
  );
  await client.connect(clientTransport);
  open.push({ client, server });
  return client;
}
