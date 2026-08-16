import { afterEach, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  createGeneratedMcpServer,
  createTypeSpecSchema,
  defineMcpApplication,
  isMcpToolError,
  McpToolError,
  mcpError,
  mcpSuccess,
  mcpWireError,
  mcpWireSuccess,
  type GeneratedMcpTool,
} from "../src/index.js";

const open: { client: Client; server: McpServer }[] = [];

afterEach(async () => {
  await Promise.all(
    open.splice(0).map(({ client, server }) => Promise.all([client.close(), server.close()])),
  );
});

describe("generated MCP server", () => {
  test("uses registry symbols for cross-instance bridge results and operational errors", async () => {
    const wireResult = mcpWireSuccess({ value: "wire" });
    expect(Object.getOwnPropertySymbols(wireResult)).toContain(
      Symbol.for("@typespex/mcp-server/wire-result"),
    );

    const operationalError = new McpToolError("Unavailable.");
    expect(Object.getOwnPropertySymbols(operationalError)).toContain(
      Symbol.for("@typespex/mcp-server/tool-error"),
    );
    const createForeignError = () => {
      const error = Object.assign(new Error("Foreign package instance."), { options: {} });
      Object.defineProperty(error, Symbol.for("@typespex/mcp-server/tool-error"), {
        value: true,
      });
      return error;
    };
    const foreignError = createForeignError();
    expect(isMcpToolError(foreignError)).toBe(true);
    expect(isMcpToolError({ message: "spoofed", options: {} })).toBe(false);

    const input = createTypeSpecSchema<Record<string, never>>({
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    });
    const success = createTypeSpecSchema<{ value: string }>({
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    });
    const foreignWireResult = { kind: "success", value: { value: "foreign wire" } };
    Object.defineProperty(foreignWireResult, Symbol.for("@typespex/mcp-server/wire-result"), {
      value: true,
    });
    const server = createGeneratedMcpServer(
      { implementation: { name: "cross-instance", version: "1.0.0" } },
      [
        { name: "throwForeign", handler: "throwForeign", input, voidResult: true },
        { name: "returnForeign", handler: "returnForeign", input, voidResult: true },
        { name: "foreignWire", handler: "foreignWire", input, success },
      ],
      // Simulate values created by a separately installed copy of @typespex/mcp-server.
      {
        handlers: {
          throwForeign() {
            throw createForeignError();
          },
          returnForeign: () => createForeignError(),
          foreignWire: () => foreignWireResult,
        },
      } as any,
    );
    const client = await connect(server, "legacy");

    for (const name of ["throwForeign", "returnForeign"]) {
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("Foreign package instance.");
      expect(JSON.stringify(result)).not.toContain("Internal tool error");
    }
    const classified = await client.callTool({ name: "foreignWire", arguments: {} });
    expect(classified.isError).not.toBe(true);
    expect(classified.structuredContent).toEqual({ value: "foreign wire" });
  });

  test("preserves typed application definitions without wrapping them", () => {
    const application = { handlers: {} };
    expect(defineMcpApplication(application)).toBe(application);
  });

  test("defers validator compilation and avoids codecs for identity contracts", async () => {
    let invalidPatternSchema: ReturnType<typeof createTypeSpecSchema> | undefined;
    expect(() => {
      invalidPatternSchema = createTypeSpecSchema({
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "string",
          pattern: "[",
        },
      });
    }).not.toThrow();
    expect(invalidPatternSchema).toBeDefined();

    const identity = createTypeSpecSchema<{ value: string }>({
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    });
    const value = { value: "same-reference" };
    const decoded = await identity.input["~standard"].validate(value);
    expect(decoded).toEqual({ value });
    if ("value" in decoded) expect(decoded.value).toBe(value);

    const projected = createTypeSpecSchema({
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          choice: {
            anyOf: [
              {
                type: "object",
                properties: { first: { type: "string" } },
                required: ["first"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: { second: { type: "string" } },
                required: ["second"],
                additionalProperties: false,
              },
            ],
          },
          list: { type: "array", items: { $ref: "#/$defs/Item" } },
          map: { type: "object", additionalProperties: { $ref: "#/$defs/Item" } },
          left: { $ref: "#/$defs/Left" },
          right: { $ref: "#/$defs/Right" },
        },
        required: ["choice", "list", "map", "left", "right"],
        additionalProperties: false,
        $defs: {
          Item: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
          Left: {
            type: "object",
            properties: { left: { type: "string" } },
            required: ["left"],
            additionalProperties: false,
          },
          Right: {
            type: "object",
            properties: { right: { type: "string" } },
            required: ["right"],
            additionalProperties: false,
          },
        },
      },
    });
    const shared = { left: "left", right: "right" };
    await expect(
      projected.encode(
        {
          choice: { second: "selected", secret: true },
          list: [{ id: "one", secret: true }],
          map: { entry: { id: "two", secret: true } },
          left: shared,
          right: shared,
          secret: true,
        },
        { validate: true },
      ),
    ).resolves.toEqual({
      ok: true,
      value: {
        choice: { second: "selected" },
        list: [{ id: "one" }],
        map: { entry: { id: "two" } },
        left: { left: "left" },
        right: { right: "right" },
      },
    });

    const recursive = createTypeSpecSchema({
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $ref: "#/$defs/Node",
        $defs: {
          Node: {
            type: "object",
            properties: {
              label: { type: "string" },
              child: { anyOf: [{ type: "null" }, { $ref: "#/$defs/Node" }] },
            },
            required: ["label"],
            additionalProperties: false,
          },
        },
      },
    });
    const cyclic: { label: string; child?: unknown } = { label: "cycle" };
    cyclic.child = cyclic;
    const cycleResult = await recursive.encode(cyclic, { validate: false });
    expect(cycleResult.ok).toBe(false);
    if (!cycleResult.ok) {
      expect(cycleResult.issues[0]?.message).toBe(
        "Cyclic semantic values cannot be encoded as JSON.",
      );
    }

    const recursiveUnion = createTypeSpecSchema({
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $ref: "#/$defs/Value",
        $defs: {
          Value: { anyOf: [{ $ref: "#/$defs/First" }, { $ref: "#/$defs/Second" }] },
          First: {
            type: "object",
            properties: {
              kind: { const: "first" },
              child: { $ref: "#/$defs/Value" },
            },
            required: ["kind"],
            additionalProperties: false,
          },
          Second: {
            type: "object",
            properties: {
              kind: { const: "second" },
              child: { $ref: "#/$defs/Value" },
            },
            required: ["kind"],
            additionalProperties: false,
          },
        },
      },
    });
    const chain: { kind: string; child?: unknown } = { kind: "second" };
    let tail = chain;
    for (let depth = 0; depth < 20; depth += 1) {
      const child: { kind: string; child?: unknown } = { kind: "second" };
      tail.child = child;
      tail = child;
    }
    const started = performance.now();
    const recursiveResult = await recursiveUnion.encode(chain, { validate: false });
    expect(recursiveResult.ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("projects wider handler objects through codec-less generated output schemas", async () => {
    const input = createTypeSpecSchema<Record<string, never>>({
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    });
    const success = createTypeSpecSchema<{ id: string; owner: { name: string } }>({
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $ref: "#/$defs/PetAlias",
        $defs: {
          PetAlias: { $ref: "#/$defs/Pet" },
          Pet: {
            type: "object",
            properties: { id: { type: "string" }, owner: { $ref: "#/$defs/Owner" } },
            required: ["id", "owner"],
            additionalProperties: false,
          },
          Owner: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            additionalProperties: false,
          },
        },
      },
    });
    const server = createGeneratedMcpServer(
      { implementation: { name: "identity-output", version: "1.0.0" } },
      [{ name: "read", handler: "read", input, success }],
      {
        handlers: {
          read: () => ({
            id: "p1",
            owner: { name: "Roman", privateNote: "internal" },
            internalScore: 42,
          }),
        },
      },
    );
    const client = await connect(server, "auto");

    const listed = await client.listTools();
    expect(listed.tools[0]?.outputSchema).toMatchObject({ type: "object" });
    const result = await client.callTool({ name: "read", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ id: "p1", owner: { name: "Roman" } });
  });

  test("reports JSON serialization failures as operational tool errors", async () => {
    const input = createTypeSpecSchema<Record<string, never>>({
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    });
    const success = createTypeSpecSchema<bigint>({
      schema: { $schema: "https://json-schema.org/draft/2020-12/schema" },
    });
    const server = createGeneratedMcpServer(
      { implementation: { name: "json-result", version: "1.0.0" } },
      [{ name: "serialize", handler: "serialize", input, success }],
      { handlers: { serialize: () => 1n } },
    );
    const client = await connect(server, "legacy");

    const result = await client.callTool({ name: "serialize", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("could not be serialized as JSON");
    expect(JSON.stringify(result)).not.toContain("Internal tool error");
  });

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
      [
        {
          name: "ambiguous",
          handler: "ambiguous",
          input: schema,
          success: schema,
          errors: schema,
          requiresTaggedResult: true,
        },
      ],
      // Deliberately bypass the generated compile-time handler type to verify runtime hardening.
      { handlers: { ambiguous: () => ({ value: "both" }) } } as any,
    );
    const client = await connect(server, "legacy");
    const result = await client.callTool({ name: "ambiguous", arguments: { value: "input" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("overlapping success and error schemas");
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
        tool("optionalVoid", { success: schema, voidResult: true }),
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
          optionalVoid: () => undefined,
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
    expect(await call("optionalVoid")).toMatchObject({ content: [] });
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

  test("validates classified bridge wire results at the server boundary", async () => {
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
      { name: "success", handler: "success", input: schema, success: schema },
      { name: "error", handler: "error", input: schema, errors: schema },
    ] as const satisfies readonly GeneratedMcpTool[];
    const server = createGeneratedMcpServer(
      { implementation: { name: "wire-results", version: "1.0.0" } },
      tools,
      {
        kind: "executor",
        executor: {
          input: "wire",
          execute(tool) {
            return tool.name === "success"
              ? mcpWireSuccess({ value: 42 })
              : mcpWireError({ value: 42 });
          },
        },
      },
    );
    const client = await connect(server, "legacy");

    for (const name of ["success", "error"]) {
      const result = await client.callTool({ name, arguments: { value: "input" } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(`invalid ${name} output`);
      expect(result.structuredContent).toBeUndefined();
    }
  });

  test("sanitizes context and error-observer failures", async () => {
    const input = createTypeSpecSchema<Record<string, never>>({
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    });
    const server = createGeneratedMcpServer(
      { implementation: { name: "context-errors", version: "1.0.0" } },
      [{ name: "run", handler: "run", input, voidResult: true }],
      {
        handlers: { run: () => undefined },
        createContext() {
          throw new Error("secret context failure");
        },
        onUnhandledError() {
          throw new Error("secret observer failure");
        },
      },
    );
    const client = await connect(server, "legacy");
    const result = await client.callTool({ name: "run", arguments: {} });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Internal tool error");
    expect(JSON.stringify(result)).not.toContain("secret");
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
