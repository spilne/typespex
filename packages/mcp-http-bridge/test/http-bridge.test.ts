import { describe, expect, test } from "bun:test";
import type { McpToolContext } from "@typespex/mcp-server";
import {
  composeHttpAuthProviders,
  environmentHttpAuthProvider,
  executeHttpBridgeTool,
  forwardInboundBearerAuthProvider,
  staticHttpAuthProvider,
  type HttpAuthProviderRequest,
  type HttpBridgeOperation,
  type HttpWireValuePlan,
} from "../src/index.js";
import { McpToolError } from "@typespex/mcp-server";

const context = {
  requestId: 1,
  signal: new AbortController().signal,
} as McpToolContext;

describe("MCP HTTP bridge", () => {
  test("serializes parameters, applies auth, and decodes declared responses", async () => {
    let request: Request | undefined;
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "getPet",
      method: "GET",
      path: "/pets/{id}",
      parameters: [
        { source: ["id"], name: "id", location: "path", required: true },
        { source: ["tags"], name: "tag", location: "query", explode: true },
        { source: ["trace"], name: "x-trace", location: "header" },
      ],
      responses: [{ statuses: [200], mediaTypes: ["application/json"], kind: "json" }],
      servers: [{ url: "https://api.example.test", fullyDefaulted: true }],
      auth: [
        {
          schemes: [{ id: "api", type: "apiKey", location: "header", name: "x-api-key" }],
        },
      ],
    };
    const result = await executeHttpBridgeTool(
      operation,
      { id: "a/b", tags: ["one", "two"], trace: "trace-1" },
      context,
      {
        authProvider: staticHttpAuthProvider({ api: "secret" }),
        fetch: (async (input, init) => {
          request = new Request(input, init);
          return Response.json({ id: "a/b", name: "Rex" });
        }) as typeof fetch,
      },
    );

    expect(result).toEqual({
      kind: "success",
      status: 200,
      value: { id: "a/b", name: "Rex" },
    });
    expect(request?.url).toBe("https://api.example.test/pets/a%2Fb?tag=one&tag=two");
    expect(request?.headers.get("x-trace")).toBe("trace-1");
    expect(request?.headers.get("x-api-key")).toBe("secret");
  });

  test("reconstructs modeled status, header, and body fields", async () => {
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "getPet",
      method: "GET",
      path: "/pets/missing",
      responses: [
        {
          statuses: [404],
          mediaTypes: ["application/json"],
          kind: "json",
          error: true,
          statusTarget: ["status"],
          bodyTarget: ["body"],
          headers: [{ name: "x-request-id", target: ["requestId"] }],
        },
      ],
      servers: [{ url: "https://api.example.test", fullyDefaulted: true }],
    };
    const result = await executeHttpBridgeTool(operation, {}, context, {
      fetch: (async () =>
        Response.json(
          { code: "not-found", message: "Missing" },
          { status: 404, headers: { "x-request-id": "req-1" } },
        )) as typeof fetch,
    });
    expect(result).toEqual({
      kind: "error",
      status: 404,
      value: {
        status: 404,
        body: { code: "not-found", message: "Missing" },
        requestId: "req-1",
      },
    });
  });

  test("treats a declared non-error response as success regardless of status class", async () => {
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "declared-alternate-success",
      method: "GET",
      path: "/lookup",
      responses: [{ statuses: [404], mediaTypes: ["application/json"], kind: "json" }],
      servers: [{ url: "https://api.example.test", fullyDefaulted: true }],
    };
    await expect(
      executeHttpBridgeTool(operation, {}, context, {
        fetch: (async () => Response.json({ found: false }, { status: 404 })) as typeof fetch,
      }),
    ).resolves.toEqual({ kind: "success", status: 404, value: { found: false } });
  });

  test("rejects dot path segments before URL normalization", async () => {
    let fetched = false;
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "safe-path",
      method: "GET",
      path: "/items/{id}",
      parameters: [
        {
          source: ["id"],
          name: "id",
          location: "path",
          required: true,
          allowReserved: true,
        },
      ],
      responses: [{ statuses: [200], kind: "json" }],
      servers: [{ url: "https://api.example.test", fullyDefaulted: true }],
    };
    for (const id of ["../admin", "..\\admin", "%2e%2e/admin"]) {
      await expect(
        executeHttpBridgeTool(operation, { id }, context, {
          fetch: (async () => {
            fetched = true;
            return Response.json({});
          }) as typeof fetch,
        }),
      ).rejects.toThrow("dot path segment");
    }
    expect(fetched).toBe(false);
  });

  test("fails required authentication before fetch", async () => {
    let fetched = false;
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "secure",
      method: "GET",
      path: "/secure",
      responses: [{ statuses: [200], kind: "json" }],
      servers: [{ url: "https://api.example.test", fullyDefaulted: true }],
      auth: [
        {
          schemes: [{ id: "bearer", type: "http", scheme: "Bearer" }],
        },
      ],
    };
    await expect(
      executeHttpBridgeTool(operation, {}, context, {
        fetch: (async () => {
          fetched = true;
          return Response.json({});
        }) as typeof fetch,
      }),
    ).rejects.toThrow("authentication is required");
    expect(fetched).toBe(false);
  });

  test("rejects empty credentials while preserving a declared no-auth alternative", async () => {
    let fetches = 0;
    const secure: HttpBridgeOperation = {
      version: 1,
      id: "secure",
      method: "GET",
      path: "/secure",
      responses: [{ statuses: [200], kind: "json" }],
      servers: [{ url: "https://api.example.test", fullyDefaulted: true }],
      auth: [
        {
          schemes: [{ id: "bearer", type: "http", scheme: "Bearer" }],
        },
      ],
    };
    const options = {
      authProvider: async () => ({}),
      fetch: (async () => {
        fetches += 1;
        return Response.json({ ok: true });
      }) as typeof fetch,
    };
    await expect(executeHttpBridgeTool(secure, {}, context, options)).rejects.toThrow(
      "No usable upstream credential",
    );
    expect(fetches).toBe(0);

    const optional = { ...secure, auth: [...secure.auth!, { schemes: [], noAuth: true }] };
    await expect(executeHttpBridgeTool(optional, {}, context, options)).resolves.toMatchObject({
      kind: "success",
      value: { ok: true },
    });
    expect(fetches).toBe(1);
  });

  test("requires an origin allowlist for dynamic server resolution", async () => {
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "dynamic",
      method: "GET",
      path: "/value",
      responses: [{ statuses: [200], kind: "json" }],
    };
    await expect(
      executeHttpBridgeTool(operation, {}, context, {
        resolveServer: () => "https://dynamic.example.test",
      }),
    ).rejects.toThrow("requires allowedUpstreamOrigins");
  });

  test("rejects ambiguous static and dynamic server configuration", async () => {
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "ambiguous-server",
      method: "GET",
      path: "/value",
      responses: [{ statuses: [200], kind: "json" }],
    };
    await expect(
      executeHttpBridgeTool(operation, {}, context, {
        server: "https://static.example.test",
        resolveServer: () => "https://dynamic.example.test",
        allowedUpstreamOrigins: ["https://static.example.test", "https://dynamic.example.test"],
      }),
    ).rejects.toThrow("either bridge.server or bridge.resolveServer, not both");
  });

  test("normalizes invalid upstream origin configuration as operational errors", async () => {
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "invalid-origin",
      method: "GET",
      path: "/value",
      responses: [{ statuses: [200], kind: "json" }],
      servers: [{ url: "https://api.example.test", fullyDefaulted: true }],
    };
    await expect(
      executeHttpBridgeTool(operation, {}, context, {
        allowedUpstreamOrigins: ["not a URL"],
      }),
    ).rejects.toThrow("Invalid allowed upstream origin");
    await expect(
      executeHttpBridgeTool(operation, {}, context, {
        allowedUpstreamOrigins: ["file:///tmp"],
      }),
    ).rejects.toThrow("must use HTTP or HTTPS");
  });

  test("enforces the upstream allowlist on the resolved base URL before fetch", async () => {
    let fetched = false;
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "allowlisted-base",
      method: "GET",
      path: "/value",
      responses: [{ statuses: [200], kind: "json" }],
      servers: [{ url: "https://api.example.test", fullyDefaulted: true }],
    };

    await expect(
      executeHttpBridgeTool(operation, {}, context, {
        allowedUpstreamOrigins: ["https://allowed.example.test"],
        fetch: (async () => {
          fetched = true;
          return Response.json({});
        }) as typeof fetch,
      }),
    ).rejects.toThrow("Resolved upstream origin https://api.example.test is not allowed");
    expect(fetched).toBe(false);
  });

  test("wires cross-origin redirect policy and strips query and header credentials", async () => {
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "redirected",
      method: "GET",
      path: "/start",
      responses: [{ statuses: [200], kind: "json" }],
      servers: [{ url: "https://api.example.test", fullyDefaulted: true }],
      auth: [
        {
          schemes: [
            { id: "query", type: "apiKey", location: "query", name: "api_key" },
            { id: "header", type: "apiKey", location: "header", name: "x-api-key" },
          ],
        },
      ],
    };
    const requests: Request[] = [];
    const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return requests.length === 1
        ? new Response(null, {
            status: 302,
            headers: {
              Location: "https://redirect.example.test/value?api_key=redirected&keep=yes",
            },
          })
        : Response.json({ ok: true });
    }) as typeof fetch;
    const authProvider = staticHttpAuthProvider({ query: "secret", header: "header-secret" });

    await expect(
      executeHttpBridgeTool(operation, {}, context, {
        allowedUpstreamOrigins: ["https://api.example.test"],
        authProvider,
        fetch: fetchMock,
      }),
    ).rejects.toThrow("Rejected cross-origin redirect to https://redirect.example.test");
    expect(requests).toHaveLength(1);

    requests.length = 0;
    await expect(
      executeHttpBridgeTool(operation, {}, context, {
        allowedUpstreamOrigins: ["https://api.example.test", "https://redirect.example.test"],
        authProvider,
        fetch: fetchMock,
      }),
    ).resolves.toMatchObject({ kind: "success", value: { ok: true } });
    expect(requests).toHaveLength(2);
    expect(new URL(requests[0]!.url).searchParams.get("api_key")).toBe("secret");
    expect(requests[0]!.headers.get("x-api-key")).toBe("header-secret");
    expect(new URL(requests[1]!.url).searchParams.has("api_key")).toBe(false);
    expect(requests[1]!.headers.has("x-api-key")).toBe(false);
    expect(new URL(requests[1]!.url).searchParams.get("keep")).toBe("yes");

    requests.length = 0;
    await expect(
      executeHttpBridgeTool(operation, {}, context, {
        authProvider,
        fetch: fetchMock,
        maxRedirects: 0,
      }),
    ).rejects.toThrow("Upstream redirect limit exceeded");
    expect(requests).toHaveLength(1);
  });

  test("normalizes invalid upstream servers and numeric limits as operational errors", async () => {
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "invalid-options",
      method: "GET",
      path: "/value",
      responses: [{ statuses: [200], kind: "json" }],
    };
    for (const server of ["api.example.test", "/relative"]) {
      const error = await executeHttpBridgeTool(operation, {}, context, { server }).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(McpToolError);
      expect(String(error)).toContain("Invalid upstream server URL");
    }

    const invalidLimit = await executeHttpBridgeTool(operation, {}, context, {
      server: "https://api.example.test",
      maxRedirects: 1.5,
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(invalidLimit).toBeInstanceOf(McpToolError);
    expect(String(invalidLimit)).toContain("maxRedirects must be an integer");

    for (const timeoutMs of [Number.NaN, -5, 0, 1.5]) {
      const invalidTimeout = await executeHttpBridgeTool(operation, {}, context, {
        server: "https://api.example.test",
        timeoutMs,
      }).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(invalidTimeout).toBeInstanceOf(McpToolError);
      expect(String(invalidTimeout)).toContain("timeoutMs must be an integer >= 1");
    }
  });

  test("redacts undeclared upstream bodies unless explicitly exposed", async () => {
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "undeclared",
      method: "GET",
      path: "/value",
      responses: [{ statuses: [200], kind: "json" }],
      servers: [{ url: "https://api.example.test", fullyDefaulted: true }],
    };
    let canceled = false;
    const secret = "database password: swordfish";
    const hiddenError = await executeHttpBridgeTool(operation, {}, context, {
      fetch: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(secret));
            },
            cancel() {
              canceled = true;
            },
          }),
          { status: 500 },
        )) as typeof fetch,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(String(hiddenError)).toContain("undeclared HTTP 500");
    expect(String(hiddenError)).not.toContain("swordfish");
    expect(canceled).toBe(true);

    await expect(
      executeHttpBridgeTool(operation, {}, context, {
        exposeUpstreamDiagnostics: true,
        fetch: (async () => new Response(secret, { status: 500 })) as typeof fetch,
      }),
    ).rejects.toThrow(secret);
  });

  test("cancels bodies declared as empty", async () => {
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "empty",
      method: "GET",
      path: "/empty",
      responses: [{ statuses: [200], kind: "empty" }],
      servers: [{ url: "https://api.example.test", fullyDefaulted: true }],
    };
    let canceled = false;
    const result = await executeHttpBridgeTool(operation, {}, context, {
      fetch: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
            cancel() {
              canceled = true;
            },
          }),
          { status: 200 },
        )) as typeof fetch,
    });
    expect(result).toEqual({ kind: "success", status: 200, value: undefined });
    expect(canceled).toBe(true);
  });

  test("enforces JSONL item and byte bounds", async () => {
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "list",
      method: "GET",
      path: "/items",
      responses: [{ statuses: [200], mediaTypes: ["application/jsonl"], kind: "jsonl" }],
      servers: [{ url: "https://api.example.test", fullyDefaulted: true }],
    };
    await expect(
      executeHttpBridgeTool(operation, {}, context, {
        maxJsonlItems: 1,
        fetch: (async () =>
          new Response('{"id":1}\n{"id":2}\n', {
            headers: { "Content-Type": "application/jsonl" },
          })) as typeof fetch,
      }),
    ).rejects.toThrow("exceeded 1 items");
  });

  test("preserves server base paths and prefers exact responses over defaults", async () => {
    let requestUrl: string | undefined;
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "prefixed",
      method: "GET",
      path: "/items",
      responses: [
        { statuses: ["default"], kind: "text", error: true },
        { statuses: [200], mediaTypes: ["application/*+json"], kind: "json" },
      ],
      servers: [{ url: "https://api.example.test/v1/", fullyDefaulted: true }],
    };
    const result = await executeHttpBridgeTool(operation, {}, context, {
      fetch: (async (input) => {
        requestUrl = String(input);
        return Response.json(
          { ok: true },
          { headers: { "content-type": "application/problem+json" } },
        );
      }) as typeof fetch,
    });
    expect(requestUrl).toBe("https://api.example.test/v1/items");
    expect(result).toEqual({ kind: "success", status: 200, value: { ok: true } });
  });

  test("expands RFC 6570 path values and preserves literal route query fields", async () => {
    let requestUrl: string | undefined;
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "segments",
      method: "GET",
      path: "/files{segments}",
      literalQuery: [{ name: "fixed", value: "full text" }],
      parameters: [
        {
          source: ["segments"],
          name: "segments",
          location: "path",
          style: "path",
          explode: true,
          required: true,
        },
      ],
      responses: [{ statuses: [200], kind: "json" }],
      servers: [{ url: "https://api.example.test/v1", fullyDefaulted: true }],
    };
    await executeHttpBridgeTool(operation, { segments: ["a/b", "c d"] }, context, {
      fetch: (async (input) => {
        requestUrl = String(input);
        return Response.json({ ok: true });
      }) as typeof fetch,
    });
    expect(requestUrl).toBe("https://api.example.test/v1/files/a%2Fb/c%20d?fixed=full+text");
  });

  test("selects request media types and defaults an omitted optional selector", async () => {
    let request: Request | undefined;
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "flexible",
      method: "POST",
      path: "/value",
      body: {
        source: ["value"],
        kind: "json",
        contentTypeSource: ["contentType"],
        mediaTypes: [
          { contentType: "application/json", kind: "json" },
          { contentType: "text/plain", kind: "text" },
        ],
      },
      responses: [{ statuses: [204], kind: "empty" }],
      servers: [{ url: "https://api.example.test", fullyDefaulted: true }],
    };
    await executeHttpBridgeTool(operation, { contentType: "text/plain", value: "hello" }, context, {
      fetch: (async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    expect(request?.headers.get("content-type")).toBe("text/plain");
    expect(await request?.text()).toBe("hello");

    request = undefined;
    await executeHttpBridgeTool(operation, { value: { message: "default" } }, context, {
      fetch: (async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(await request?.json()).toEqual({ message: "default" });
  });

  test("rejects unsafe generated and file Content-Type values as operational errors", async () => {
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "unsafe-content-type",
      method: "POST",
      path: "/file",
      body: {
        source: ["file"],
        kind: "file",
        contentType: "application/octet-stream",
      },
      responses: [{ statuses: [204], kind: "empty" }],
      servers: [{ url: "https://api.example.test", fullyDefaulted: true }],
    };
    for (const mediaType of ["text/plain\r\nx-injected: true", "image/png\u0000"]) {
      await expect(
        executeHttpBridgeTool(
          operation,
          {
            file: {
              name: "unsafe.txt",
              mediaType,
              data: "",
            },
          },
          context,
          { fetch: (async () => new Response(null, { status: 204 })) as typeof fetch },
        ),
      ).rejects.toThrow("Rejected invalid HTTP header value");
    }

    const multipartOperation: HttpBridgeOperation = {
      ...operation,
      id: "unsafe-multipart-content-type",
      body: {
        source: ["file"],
        kind: "multipart",
        contentType: "multipart/form-data",
        multipartParts: [
          {
            source: ["file"],
            name: "file",
            multi: false,
            optional: false,
            kind: "file",
            contentTypes: ["application/octet-stream"],
          },
        ],
      },
    };
    for (const mediaType of ["text/plain\r\nx-injected: true", "image/png\u0000"]) {
      let fetched = false;
      await expect(
        executeHttpBridgeTool(
          multipartOperation,
          { file: { name: "unsafe.txt", mediaType, data: "" } },
          context,
          {
            fetch: (async () => {
              fetched = true;
              return new Response(null, { status: 204 });
            }) as typeof fetch,
          },
        ),
      ).rejects.toThrow("Rejected invalid HTTP header value");
      expect(fetched).toBe(false);
    }

    await expect(
      executeHttpBridgeTool(
        {
          ...operation,
          body: undefined,
          parameters: [
            { source: ["value"], name: "invalid header", location: "header", required: true },
          ],
        },
        { value: "present" },
        context,
        { fetch: (async () => new Response(null, { status: 204 })) as typeof fetch },
      ),
    ).rejects.toThrow("Rejected invalid HTTP header value");
  });

  test("omits absent optional fields from property-composed request bodies", async () => {
    let request: Request | undefined;
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "composed-body",
      method: "POST",
      path: "/pets",
      body: {
        kind: "json",
        fields: [
          { source: ["name"], target: ["name"] },
          { source: ["tag"], target: ["tag"] },
        ],
        value: {
          kind: "object",
          properties: {
            name: { sourceName: "name", value: { kind: "string" }, optional: false },
            tag: { sourceName: "tag", value: { kind: "string" }, optional: true },
          },
        },
      },
      responses: [{ statuses: [204], kind: "empty" }],
      servers: [{ url: "https://api.example.test", fullyDefaulted: true }],
    };
    await executeHttpBridgeTool(operation, { name: "Poppy" }, context, {
      fetch: (async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    expect(await request?.json()).toEqual({ name: "Poppy" });
  });

  test("writes planned multipart parts with names, files, and multiplicity", async () => {
    let request: Request | undefined;
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "upload",
      method: "POST",
      path: "/upload",
      body: {
        source: ["body"],
        kind: "multipart",
        contentType: "multipart/form-data",
        multipartParts: [
          {
            source: ["body", "label"],
            name: "wire-label",
            multi: false,
            optional: false,
            kind: "text",
            contentTypes: ["text/plain"],
          },
          {
            source: ["body", "files"],
            name: "files",
            multi: true,
            optional: false,
            kind: "file",
            contentTypes: ["application/octet-stream"],
          },
        ],
      },
      responses: [{ statuses: [204], kind: "empty" }],
      servers: [{ url: "https://api.example.test", fullyDefaulted: true }],
    };
    await executeHttpBridgeTool(
      operation,
      {
        body: {
          label: "sample",
          files: [
            { name: "a.txt", mediaType: "text/plain", data: "QQ==" },
            { name: "b.bin", data: "Qg==" },
          ],
        },
      },
      context,
      {
        fetch: (async (input, init) => {
          request = new Request(input, init);
          return new Response(null, { status: 204 });
        }) as typeof fetch,
      },
    );
    const contentType = request?.headers.get("content-type") ?? "";
    const payload = await request?.text();
    expect(contentType).toMatch(/^multipart\/form-data; boundary=typespex-/);
    expect(payload).toContain('name="wire-label"');
    expect(payload).toContain('name="files"; filename="a.txt"');
    expect(payload).toContain('name="files"; filename="b.bin"');
    expect(payload).toContain("sample");
  });

  test("reconstructs tuple targets and repeated response headers", async () => {
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "tuple",
      method: "GET",
      path: "/tuple",
      responses: [
        {
          statuses: [200],
          kind: "json",
          bodyTarget: [0],
          headers: [{ name: "x-tags", target: [1], collection: true }],
        },
      ],
      servers: [{ url: "https://api.example.test", fullyDefaulted: true }],
    };
    const result = await executeHttpBridgeTool(operation, {}, context, {
      fetch: (async () =>
        Response.json({ value: true }, { headers: { "x-tags": "one, two" } })) as typeof fetch,
    });
    expect(result.value).toEqual([{ value: true }, ["one", "two"]]);
  });

  test("maps form field names and coerces declared scalar wire types", async () => {
    let request: Request | undefined;
    const formValue = {
      kind: "object" as const,
      properties: {
        localName: {
          sourceName: "wire-name",
          value: { kind: "string" as const },
          optional: false,
        },
        count: {
          sourceName: "count",
          value: { kind: "number" as const, integer: true },
          optional: false,
        },
        enabled: {
          sourceName: "enabled",
          value: { kind: "boolean" as const },
          optional: false,
        },
        tags: {
          sourceName: "tag",
          value: { kind: "array" as const, item: { kind: "string" as const } },
          optional: false,
        },
      },
    };
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "form",
      method: "POST",
      path: "/form",
      body: {
        source: ["body"],
        kind: "form",
        contentType: "application/x-www-form-urlencoded",
        value: formValue,
      },
      responses: [
        {
          statuses: [200],
          mediaTypes: ["application/x-www-form-urlencoded"],
          kind: "form",
          bodyValue: formValue,
        },
      ],
      servers: [{ url: "https://api.example.test", fullyDefaulted: true }],
    };
    const result = await executeHttpBridgeTool(
      operation,
      {
        body: {
          localName: "Ada",
          count: 42,
          enabled: true,
          tags: ["one", "two"],
        },
      },
      context,
      {
        fetch: (async (input, init) => {
          request = new Request(input, init);
          return new Response("wire-name=Ada&count=43&enabled=false&tag=three&tag=four", {
            headers: { "content-type": "application/x-www-form-urlencoded" },
          });
        }) as typeof fetch,
      },
    );
    expect(await request?.text()).toBe("wire-name=Ada&count=42&enabled=true&tag=one&tag=two");
    expect(result.value).toEqual({
      localName: "Ada",
      count: 43,
      enabled: false,
      tags: ["three", "four"],
    });
  });

  test("converts canonical MCP scalars to declared HTTP encodings", async () => {
    let request: Request | undefined;
    const rfcDate = new Date("2026-08-15T12:00:00Z").toUTCString();
    const encodedObject = {
      kind: "object" as const,
      properties: {
        count: {
          sourceName: "count",
          optional: false,
          value: { kind: "scalar-encoding" as const, encoding: "integer-string" as const },
        },
        enabled: {
          sourceName: "enabled",
          optional: false,
          value: { kind: "scalar-encoding" as const, encoding: "boolean-string" as const },
        },
        updatedAt: {
          sourceName: "updated_at",
          optional: false,
          value: { kind: "scalar-encoding" as const, encoding: "rfc7231" as const },
        },
        ttl: {
          sourceName: "ttl_seconds",
          optional: false,
          value: { kind: "scalar-encoding" as const, encoding: "duration-seconds" as const },
        },
        token: {
          sourceName: "token",
          optional: false,
          value: { kind: "scalar-encoding" as const, encoding: "base64url" as const },
        },
      },
    };
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "encoded",
      method: "POST",
      path: "/encoded",
      parameters: [
        {
          source: ["when"],
          name: "x-when",
          location: "header",
          value: { kind: "scalar-encoding", encoding: "rfc7231" },
        },
        {
          source: ["count"],
          name: "count",
          location: "query",
          value: { kind: "scalar-encoding", encoding: "integer-string" },
        },
        {
          source: ["since"],
          name: "since",
          location: "query",
          value: { kind: "scalar-encoding", encoding: "unix-timestamp" },
        },
      ],
      body: {
        source: ["body"],
        kind: "json",
        contentType: "application/json",
        value: encodedObject,
      },
      responses: [
        {
          statuses: [200],
          mediaTypes: ["application/json"],
          kind: "json",
          bodyTarget: ["body"],
          bodyValue: encodedObject,
          headers: [
            {
              name: "x-when",
              target: ["when"],
              value: { kind: "scalar-encoding", encoding: "rfc7231" },
            },
          ],
        },
      ],
      servers: [{ url: "https://api.example.test", fullyDefaulted: true }],
    };
    const result = await executeHttpBridgeTool(
      operation,
      {
        when: "2026-08-15T12:00:00Z",
        since: "1970-01-01T00:01:00Z",
        count: 42,
        body: {
          count: 42,
          enabled: true,
          updatedAt: "2026-08-15T12:00:00Z",
          ttl: "PT1.5S",
          token: "+/8=",
        },
      },
      context,
      {
        fetch: (async (input, init) => {
          request = new Request(input, init);
          return Response.json(
            {
              count: "43",
              enabled: "false",
              updated_at: rfcDate,
              ttl_seconds: 2,
              token: "-_8",
            },
            { headers: { "x-when": rfcDate } },
          );
        }) as typeof fetch,
      },
    );
    expect(request?.url).toBe("https://api.example.test/encoded?count=42&since=60");
    expect(request?.headers.get("x-when")).toBe(rfcDate);
    expect(await request?.json()).toEqual({
      count: "42",
      enabled: "true",
      updated_at: rfcDate,
      ttl_seconds: 1.5,
      token: "-_8",
    });
    expect(result.value).toEqual({
      body: {
        count: 43,
        enabled: false,
        updatedAt: "2026-08-15T12:00:00.000Z",
        ttl: "PT2S",
        token: "+/8=",
      },
      when: "2026-08-15T12:00:00.000Z",
    });
  });

  test("translates structured JSON files to the MCP file record", async () => {
    let upstreamBody: unknown;
    const fileValue = {
      kind: "object" as const,
      properties: {
        file: {
          sourceName: "upload",
          optional: false,
          value: {
            kind: "file-json" as const,
            contentTypeSource: "contentType",
            filenameSource: "filename",
            contentsSource: "contents",
            textContents: false,
          },
        },
      },
    };
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "json-file",
      method: "POST",
      path: "/json-file",
      body: {
        source: ["body"],
        kind: "json",
        contentType: "application/json",
        value: fileValue,
      },
      responses: [
        {
          statuses: [200],
          mediaTypes: ["application/json"],
          kind: "json",
          bodyValue: fileValue,
        },
      ],
      servers: [{ url: "https://api.example.test", fullyDefaulted: true }],
    };
    const result = await executeHttpBridgeTool(
      operation,
      {
        body: {
          file: { name: "pixel.png", mediaType: "image/png", data: "AQI=" },
        },
      },
      context,
      {
        fetch: (async (_input, init) => {
          upstreamBody = JSON.parse(String(init?.body));
          return Response.json(upstreamBody);
        }) as typeof fetch,
      },
    );
    expect(upstreamBody).toEqual({
      upload: { contentType: "image/png", filename: "pixel.png", contents: "AQI=" },
    });
    expect(result.value).toEqual({
      file: { name: "pixel.png", mediaType: "image/png", data: "AQI=" },
    });
  });

  test("decodes planned multipart responses including repeated files", async () => {
    const boundary = "response-boundary";
    const payload = [
      `--${boundary}\r\nContent-Disposition: form-data; name="label"\r\nContent-Type: text/plain\r\n\r\nsample\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nA\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="b.txt"\r\nContent-Type: text/plain\r\n\r\nB\r\n`,
      `--${boundary}--\r\n`,
    ].join("");
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "download-parts",
      method: "GET",
      path: "/parts",
      responses: [
        {
          statuses: [200],
          mediaTypes: ["multipart/form-data"],
          kind: "multipart",
          multipartParts: [
            {
              target: ["label"],
              name: "label",
              multi: false,
              optional: false,
              kind: "text",
              contentTypes: ["text/plain"],
              value: { kind: "string" },
            },
            {
              target: ["files"],
              name: "files",
              multi: true,
              optional: false,
              kind: "file",
              contentTypes: ["text/plain"],
            },
          ],
        },
      ],
      servers: [{ url: "https://api.example.test", fullyDefaulted: true }],
    };
    const result = await executeHttpBridgeTool(operation, {}, context, {
      fetch: (async () =>
        new Response(payload, {
          headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        })) as typeof fetch,
    });
    expect(result.value).toEqual({
      label: "sample",
      files: [
        { name: "a.txt", mediaType: "text/plain", data: "QQ==" },
        { name: "b.txt", mediaType: "text/plain", data: "Qg==" },
      ],
    });
  });

  test("composes static, environment, and inbound bearer auth providers", async () => {
    const request = {
      operation: { id: "auth", method: "GET", path: "/", responses: [] },
      alternatives: [
        {
          schemes: [
            { id: "header", type: "apiKey", location: "header", name: "x-key" },
            { id: "query", type: "apiKey", location: "query", name: "api_key" },
            { id: "cookie", type: "apiKey", location: "cookie", name: "session" },
            { id: "basic", type: "http", scheme: "Basic" },
          ],
        },
      ],
      input: {},
      context: { ...context, authInfo: { token: "inbound", clientId: "client", scopes: [] } },
    } satisfies HttpAuthProviderRequest;
    const staticProvider = staticHttpAuthProvider({
      header: "header-secret",
      query: "query-secret",
      cookie: "cookie-secret",
      basic: { value: "basic-secret", prefix: "Custom" },
    });
    expect(await staticProvider(request)).toEqual({
      headers: { "x-key": "header-secret", Authorization: "Custom basic-secret" },
      query: { api_key: "query-secret" },
      cookies: { session: "cookie-secret" },
    });
    expect(await staticHttpAuthProvider({})(request)).toBeUndefined();
    const optionalBearerRequest = {
      ...request,
      alternatives: [
        { schemes: [], noAuth: true },
        { schemes: [{ id: "bearer", type: "http", scheme: "Bearer" }] },
      ],
    } satisfies HttpAuthProviderRequest;
    expect(await staticHttpAuthProvider({ bearer: "configured" })(optionalBearerRequest)).toEqual({
      headers: { Authorization: "Bearer configured" },
    });
    expect(await staticHttpAuthProvider({})(optionalBearerRequest)).toEqual({});
    expect(
      await staticHttpAuthProvider({ real: "configured" })({
        ...request,
        alternatives: [{ schemes: [{ id: "toString", type: "http", scheme: "Bearer" }] }],
      }),
    ).toBeUndefined();

    const environmentProvider = environmentHttpAuthProvider(
      { header: "HEADER_TOKEN" },
      { HEADER_TOKEN: "from-env" },
    );
    expect(
      await environmentProvider({
        ...request,
        alternatives: [
          {
            schemes: [{ id: "header", type: "apiKey", location: "header", name: "x-key" }],
          },
        ],
      }),
    ).toEqual({ headers: { "x-key": "from-env" } });
    expect(environmentHttpAuthProvider({})).toBeFunction();

    const composed = composeHttpAuthProviders(
      async () => undefined,
      async () => ({ query: { selected: "yes" } }),
    );
    expect(await composed(request)).toEqual({ query: { selected: "yes" } });
    expect(await composeHttpAuthProviders(async () => undefined)(request)).toBeUndefined();

    const forward = forwardInboundBearerAuthProvider();
    expect(
      await forward({
        ...request,
        alternatives: [{ schemes: [{ id: "oauth", type: "oauth2" }] }],
      }),
    ).toEqual({ headers: { Authorization: "Bearer inbound" } });
    expect(
      await forward({
        ...request,
        alternatives: [{ schemes: [{ id: "digest", type: "http", scheme: "Digest" }] }],
      }),
    ).toBeUndefined();
    expect(
      await forward({
        ...request,
        context: context,
        alternatives: [{ schemes: [{ id: "bearer", type: "http", scheme: "Bearer" }] }],
      }),
    ).toBeUndefined();
  });

  test("round-trips every composite HTTP wire value through a JSON body", async () => {
    const valuePlan: HttpWireValuePlan = {
      kind: "object",
      properties: {
        text: { sourceName: "wire_text", value: { kind: "string" }, optional: false },
        number: {
          sourceName: "wire_number",
          value: { kind: "number", integer: false },
          optional: false,
        },
        integer: {
          sourceName: "wire_integer",
          value: { kind: "number", integer: true },
          optional: false,
        },
        truth: { sourceName: "wire_truth", value: { kind: "boolean" }, optional: false },
        nothing: { sourceName: "wire_null", value: { kind: "null" }, optional: false },
        literal: {
          sourceName: "wire_literal",
          value: { kind: "literal", value: "fixed" },
          optional: false,
        },
        items: {
          sourceName: "wire_items",
          value: { kind: "array", item: { kind: "number", integer: true } },
          optional: false,
        },
        pair: {
          sourceName: "wire_pair",
          value: { kind: "tuple", items: [{ kind: "string" }, { kind: "boolean" }] },
          optional: false,
        },
        choice: {
          sourceName: "wire_choice",
          value: { kind: "union", variants: [{ kind: "number" }, { kind: "string" }] },
          optional: false,
        },
        decimal: {
          sourceName: "wire_decimal",
          value: { kind: "scalar-encoding", encoding: "number-string" },
          optional: false,
        },
        delay: {
          sourceName: "wire_delay",
          value: { kind: "scalar-encoding", encoding: "duration-milliseconds" },
          optional: false,
        },
        textFile: {
          sourceName: "wire_file",
          value: {
            kind: "file-json",
            filenameSource: "filename",
            contentsSource: "contents",
            textContents: true,
          },
          optional: false,
        },
        omitted: { sourceName: "omitted", value: { kind: "identity" }, optional: true },
      },
      additional: { kind: "boolean" },
    };
    let wireBody: Record<string, unknown> | undefined;
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "wire-values",
      method: "POST",
      path: "/wire-values",
      body: { source: ["body"], kind: "json", value: valuePlan },
      responses: [{ statuses: [200], kind: "json", bodyValue: valuePlan }],
      servers: [{ url: "https://api.example.test", fullyDefaulted: true }],
    };
    const semanticBody = {
      text: "hello",
      number: 1.25,
      integer: 2,
      truth: true,
      nothing: null,
      literal: "fixed",
      items: [1, 2],
      pair: ["left", false],
      choice: "selected",
      decimal: 12.5,
      delay: "PT1.5S",
      textFile: { name: "note.txt", data: "SGk=" },
      extra: false,
    };
    const result = await executeHttpBridgeTool(operation, { body: semanticBody }, context, {
      fetch: (async (_input, init) => {
        wireBody = JSON.parse(String(init?.body));
        return Response.json(wireBody);
      }) as typeof fetch,
    });
    expect(wireBody).toMatchObject({
      wire_text: "hello",
      wire_number: 1.25,
      wire_integer: 2,
      wire_truth: true,
      wire_null: null,
      wire_literal: "fixed",
      wire_items: [1, 2],
      wire_pair: ["left", false],
      wire_choice: "selected",
      wire_decimal: "12.5",
      wire_delay: 1500,
      wire_file: { filename: "note.txt", contents: "Hi" },
      extra: false,
    });
    expect(result.value).toEqual(semanticBody);
  });

  test("preserves wire transforms throughout recursive values", async () => {
    const nodePlan: HttpWireValuePlan = {
      kind: "definition",
      name: "Node#0",
      value: {
        kind: "object",
        properties: {
          label: {
            sourceName: "wire_label",
            value: { kind: "string" },
            optional: false,
          },
          next: {
            sourceName: "wire_next",
            value: { kind: "ref", name: "Node#0" },
            optional: true,
          },
        },
      },
    };
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "recursive-values",
      method: "POST",
      path: "/recursive-values",
      body: { source: ["body"], kind: "json", value: nodePlan },
      responses: [{ statuses: [200], kind: "json", bodyValue: nodePlan }],
      servers: [{ url: "https://api.example.test", fullyDefaulted: true }],
    };
    const semanticBody = { label: "root", next: { label: "child" } };
    let wireBody: unknown;
    const result = await executeHttpBridgeTool(operation, { body: semanticBody }, context, {
      fetch: (async (_input, init) => {
        wireBody = JSON.parse(String(init?.body));
        return Response.json(wireBody);
      }) as typeof fetch,
    });

    expect(wireBody).toEqual({
      wire_label: "root",
      wire_next: { wire_label: "child" },
    });
    expect(result.value).toEqual(semanticBody);
  });

  test("serializes path, query, header, cookie, and auth credential styles", async () => {
    let request: Request | undefined;
    const operation: HttpBridgeOperation = {
      version: 1,
      id: "styles",
      method: "GET",
      path: "/root/{optional}{label}/{matrix}/{segments}/{simple}",
      literalQuery: [{ name: "fixed", value: "yes" }],
      parameters: [
        { source: ["optional"], name: "optional", location: "path" },
        {
          source: ["label"],
          name: "label",
          location: "path",
          style: "label",
          value: { kind: "array", item: { kind: "string" } },
        },
        {
          source: ["matrix"],
          name: "matrix",
          location: "path",
          style: "matrix",
          explode: true,
        },
        {
          source: ["segments"],
          name: "segments",
          location: "path",
          style: "path",
          explode: false,
          allowReserved: true,
        },
        { source: ["simple"], name: "simple", location: "path", explode: true },
        { source: ["deep"], name: "filter", location: "query", style: "deepObject" },
        { source: ["spaces"], name: "spaces", location: "query", style: "spaceDelimited" },
        { source: ["pipes"], name: "pipes", location: "query", style: "pipeDelimited" },
        { source: ["object"], name: "object", location: "query", explode: true },
        { source: ["packed"], name: "packed", location: "query", explode: false },
        { source: ["header"], name: "x-values", location: "header", explode: true },
        { source: ["cookieArray"], name: "item", location: "cookie", explode: true },
        { source: ["packedCookie"], name: "packed", location: "cookie", explode: false },
        { source: ["cookieObject"], name: "object", location: "cookie", explode: true },
        { source: ["cookieMap"], name: "map", location: "cookie", explode: false },
        { source: ["cookieScalar"], name: "scalar", location: "cookie" },
      ],
      responses: [{ statuses: [204], kind: "empty" }],
      servers: [{ url: "https://api.example.test/base", fullyDefaulted: true }],
      auth: [
        {
          schemes: [
            { id: "queryAuth", type: "apiKey", location: "query", name: "token" },
            { id: "cookieAuth", type: "apiKey", location: "cookie", name: "scalar" },
          ],
        },
      ],
    };
    await executeHttpBridgeTool(
      operation,
      {
        label: ["a", "b"],
        matrix: { first: 1, second: 2 },
        segments: { one: "a/b", two: "c" },
        simple: { x: 1, y: 2 },
        deep: { name: "Ada", role: "admin" },
        spaces: ["a", "b"],
        pipes: ["c", "d"],
        object: { one: 1, two: 2 },
        packed: { three: 3, four: 4 },
        header: { one: 1, two: 2 },
        cookieArray: ["a", "b"],
        packedCookie: ["c", "d"],
        cookieObject: { first: 1, second: 2 },
        cookieMap: { third: 3, fourth: 4 },
        cookieScalar: "original",
      },
      context,
      {
        authProvider: staticHttpAuthProvider({ queryAuth: "query-token", cookieAuth: "override" }),
        fetch: (async (input, init) => {
          request = new Request(input, init);
          return new Response(null, { status: 204 });
        }) as typeof fetch,
      },
    );
    const url = new URL(request!.url);
    expect(url.pathname).toContain("/base/root/.a,b");
    expect(url.searchParams.get("filter[name]")).toBe("Ada");
    expect(url.searchParams.get("spaces")).toBe("a b");
    expect(url.searchParams.get("pipes")).toBe("c|d");
    expect(url.searchParams.get("one")).toBe("1");
    expect(url.searchParams.get("packed")).toBe("three,3,four,4");
    expect(url.searchParams.get("token")).toBe("query-token");
    expect(request?.headers.get("x-values")).toBe("one=1,two=2");
    const cookie = request?.headers.get("cookie") ?? "";
    expect(cookie).toContain("item=a");
    expect(cookie).toContain("packed=c%2Cd");
    expect(cookie).toContain("first=1");
    expect(cookie).toContain("map=third%2C3%2Cfourth%2C4");
    expect(cookie).toContain("scalar=override");
  });
});
