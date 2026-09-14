import { describe, expect, test } from "bun:test";
import { createConnection } from "node:net";
import {
  bindRoute,
  createHttpRouter,
  decodeBody,
  Decoders,
  Either,
  emptyHints,
  type HttpRouter,
  type RoutePattern,
  type ServerOperation,
} from "@typespex/http-server";
import { toBunHandler } from "../src/index.js";
import { createBunServer } from "../src/server.js";

const silentLogger = { error() {}, warn() {}, info() {} };

function operation(path: string, method = "GET", pattern?: RoutePattern) {
  return {
    endpoint: {
      service: { name: "Test", hints: emptyHints() },
      namespaces: [],
      operation: {
        name: path,
        operationId: path,
        method,
        path,
        routePattern: pattern,
        hints: emptyHints(),
      },
    },
    decodeInput: (_request, params) => Either.right(params),
    encodeResult: (params) => Response.json({ path, params }),
  } satisfies ServerOperation<Readonly<Record<string, string>>, Readonly<Record<string, string>>>;
}

function echoRouter(
  maximum = 5,
  decoderMaximum?: number,
  middleware?: Parameters<typeof createHttpRouter>[1],
) {
  const echo: ServerOperation<string, string> = {
    ...operation("/body", "POST"),
    decodeInput: (request) =>
      decodeBody(
        request,
        { text: Decoders.string },
        {
          contentTypes: ["text/plain"],
          maxRequestBodyBytes: decoderMaximum,
        },
      ),
    encodeResult: (value) => new Response(value),
  };
  return createHttpRouter([bindRoute(echo, (value) => value)], {
    ...middleware,
    maxRequestBodyBytes: maximum,
  });
}

function rawHttp(port: number, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(2000, () => socket.destroy(new Error("Raw HTTP request timed out.")));
    socket.on("connect", () => socket.write(message));
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(response));
  });
}

describe("createBunServer", () => {
  test("native registration uses the same configuration snapshot as the router", async () => {
    const literal = { kind: "literal" as const, value: "before" };
    const router = createHttpRouter([
      bindRoute(
        operation("/before", "GET", {
          segments: [[literal]],
          trailingSlash: false,
        }),
        (value) => value,
      ),
    ]);
    literal.value = "after";
    const server = createBunServer(router, { port: 0, hostname: "127.0.0.1" });
    try {
      for (const [path, status] of [
        ["before", 200],
        ["after", 404],
      ]) {
        const response = await fetch(`${server.url}${path}`);
        expect(response.status).toBe(status);
        await response.text();
      }
    } finally {
      await server.stop(true);
    }
  });
  test("raw targets and Host values cannot select a different operation than Request.url", async () => {
    const paths = [
      "/pets/:petId",
      "/:a/:b/pets/:id",
      "/pets/:x/:id",
      "/:a/:b/:c",
      "/pets",
      "/:p",
      "/",
    ];
    const router = createHttpRouter(
      paths.map((path) => bindRoute(operation(path), (value) => value)),
    );
    const ordinary = Bun.serve({ port: 0, hostname: "127.0.0.1", ...toBunHandler(router) });
    const native = createBunServer(router, { port: 0, hostname: "127.0.0.1" });
    try {
      for (const target of [
        "/pets/a",
        "/pets/./a",
        "/x/../pets/a",
        "/pets/a/../b",
        "/pets/a\\b",
        "/pets/.%2Fa",
        "/pets/a#fragment",
        "http://localhost/pets/a",
        "http://localhost/pets/./a",
        "http://localhost/x/../pets/a",
        "*",
        "/",
        "/pets/..",
      ]) {
        for (const host of [
          "localhost",
          " localhost ",
          "localhost\t",
          "local\thost",
          "localhost:99999",
          "256.256.256.256",
          "localhost%2f",
          "user@localhost",
          "",
          "localhost/pets/alpha",
          "localhost/other",
          "localhost?query",
          "localhost#fragment",
          "localhost/pets/alpha\r\nHost: localhost",
          "localhost\r\nHost: localhost/pets/alpha",
          "localhost?x\r\nHost: localhost",
          "localhost\r\nHost: localhost?x",
        ]) {
          const results = [];
          for (const server of [ordinary, native]) {
            const response = await rawHttp(
              server.port!,
              `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
            );
            const [headers, ...body] = response.split("\r\n\r\n");
            results.push([headers!.split("\r\n")[0], body.join("\r\n\r\n")]);
          }
          expect(results[1], `${target} Host: ${host}`).toEqual(results[0]);
        }
      }
    } finally {
      await ordinary.stop(true);
      await native.stop(true);
    }
  });

  test("explicit HEAD routes and non-standard methods preserve router selection", async () => {
    const head = {
      ...operation("/pets", "HEAD"),
      encodeResult: () => new Response(null, { status: 202 }),
    };
    const get = operation("/pets");
    const router = createHttpRouter([
      bindRoute(get, (value) => value),
      bindRoute(head, (value) => value),
    ]);
    const server = createBunServer(router, { port: 0, hostname: "127.0.0.1" });
    try {
      for (const [method, status] of [
        ["HEAD", 202],
        ["GET", 200],
        ["PROPFIND", 404],
        ["TRACE", 404],
      ]) {
        const response = await rawHttp(
          server.port!,
          `${method} /pets HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
        );
        expect(response).toStartWith(`HTTP/1.1 ${status} `);
      }
    } finally {
      await server.stop(true);
    }
  });

  test("the Bun server cap can reject a body before the router's larger limit", async () => {
    const server = createBunServer(echoRouter(100), {
      port: 0,
      hostname: "127.0.0.1",
      maxRequestBodySize: 3,
    });
    try {
      const response = await fetch(`${server.url}body`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "hello",
      });
      expect(response.status).toBe(413);
      await response.text();
    } finally {
      await server.stop(true);
    }
  });
  test("native routes agree with Fetch routing across methods, escapes, and exact slashes", async () => {
    const paths = [
      "/",
      "/pets",
      "/pets/new",
      "/pets/:petId",
      "/pets/:petId/",
      "/groups/:groupId/pets/:petId",
    ];
    const routes = paths.map((path) =>
      bindRoute(
        operation(path, "GET", {
          segments: path
            .split("/")
            .filter(Boolean)
            .map((segment) => [
              segment.startsWith(":")
                ? { kind: "parameter", name: segment.slice(1) }
                : { kind: "literal", value: segment },
            ]),
          trailingSlash: path.endsWith("/"),
        }),
        (value) => value,
      ),
    );
    const router = createHttpRouter(routes);
    const ordinary = Bun.serve({ port: 0, hostname: "127.0.0.1", ...toBunHandler(router) });
    const native = createBunServer(router, { port: 0, hostname: "127.0.0.1" });
    try {
      for (const path of [
        "/",
        "/pets",
        "/pets/",
        "/pets/new",
        "/pets/new/",
        "/pets/alpha",
        "/pets/alpha/",
        "/pets//alpha",
        "//pets/alpha",
        "/Pets/alpha",
        "/%70ets/alpha",
        "/pets/al%70ha",
        "/pets/a%2Fb",
        "/pets/%25",
        "/pets/a%252Fb",
        "/pets/%ZZ",
        "/pets/é",
        "/pets/🚀",
        "/pets/a:b",
        "/pets/a.b",
        "/pets/a;b",
        "/pets/a?filter=%2F",
        "/groups/a/pets/b",
        "/missing",
      ]) {
        for (const method of ["GET", "HEAD", "POST", "OPTIONS"]) {
          const results = [];
          for (const server of [ordinary, native]) {
            const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
              method,
              headers: { connection: "close" },
            });
            results.push({ status: response.status, text: await response.text() });
          }
          expect(results[1], `${method} ${path}`).toEqual(results[0]);
        }
      }
    } finally {
      await ordinary.stop(true);
      await native.stop(true);
    }
  });

  test.each([
    operation("/files/:part", "GET", {
      segments: [[{ kind: "literal", value: "files" }], [{ kind: "rest", name: "part" }]],
      trailingSlash: false,
    }),
    operation("/files/{name}.json", "GET", {
      segments: [
        [{ kind: "literal", value: "files" }],
        [
          { kind: "parameter", name: "name" },
          { kind: "literal", value: ".json" },
        ],
      ],
      trailingSlash: false,
    }),
    operation("/café"),
    operation("/files/:part", "PROPFIND"),
  ])(
    "preserves unsupported native pattern or method: $endpoint.operation.path",
    async (special) => {
      const normal = operation("/normal");
      const router = createHttpRouter([
        bindRoute(normal, (value) => value),
        bindRoute(special, (value) => value),
      ]);
      const ordinary = Bun.serve({ port: 0, hostname: "127.0.0.1", ...toBunHandler(router) });
      const native = createBunServer(router, { port: 0, hostname: "127.0.0.1" });
      try {
        for (const path of ["/normal", "/files/a/b", "/files/a.json", "/café"]) {
          const results = [];
          for (const server of [ordinary, native]) {
            const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
              method: special.endpoint.operation.method,
            });
            results.push({ status: response.status, text: await response.text() });
          }
          expect(results[1]).toEqual(results[0]);
        }
      } finally {
        await ordinary.stop(true);
        await native.stop(true);
      }
    },
  );

  test("shared route selection and custom matchers keep control", async () => {
    const selected = { ...operation("/selected") };
    selected.endpoint.operation = {
      ...selected.endpoint.operation,
      routeSelection: { query: [{ name: "kind", value: "one" }] },
    } as typeof selected.endpoint.operation;
    const bindings = [bindRoute(selected, (value) => value)];
    for (const router of [
      createHttpRouter(bindings),
      createHttpRouter(bindings, {}, { match: () => null }),
    ]) {
      const native = createBunServer(router, { port: 0, hostname: "127.0.0.1" });
      try {
        for (const path of ["/selected", "/selected?kind=one", "/selected?kind=two"]) {
          const expected = await router.handle(new Request(`http://localhost${path}`));
          const actual = await fetch(`http://127.0.0.1:${native.port}${path}`);
          expect([actual.status, await actual.text()]).toEqual([
            expected.status,
            await expected.text(),
          ]);
        }
      } finally {
        await native.stop(true);
      }
    }
  });

  test.each(["spread", "inherited", "replaced"] as const)(
    "preserves %s router authorization guards",
    async (wrapping) => {
      const base = echoRouter();
      const original = base.handle;
      const guarded = (request: Request) =>
        request.headers.has("authorization")
          ? original(request)
          : Promise.resolve(new Response("Unauthorized", { status: 401 }));
      const router: HttpRouter =
        wrapping === "spread"
          ? { ...base, handle: guarded }
          : wrapping === "inherited"
            ? Object.assign(Object.create(base), { handle: guarded })
            : base;
      const server = createBunServer(router, { port: 0, hostname: "127.0.0.1" });
      if (wrapping === "replaced") router.handle = guarded;
      try {
        for (const authorized of [false, true]) {
          const response = await fetch(`${server.url}body`, {
            method: "POST",
            headers: {
              "content-type": "text/plain",
              ...(authorized ? { authorization: "test" } : {}),
            },
            body: "hello",
          });
          expect(response.status).toBe(authorized ? 200 : 401);
          expect(await response.text()).toBe(authorized ? "hello" : "Unauthorized");
        }
      } finally {
        await server.stop(true);
      }
    },
  );

  test("enforces framing limits before middleware and tighter decoder limits", async () => {
    let entered = 0;
    const server = createBunServer(
      echoRouter(5, 3, {
        middleware: [
          (next) => async (context) => {
            entered++;
            return next(context);
          },
        ],
      }),
      { port: 0, hostname: "127.0.0.1" },
    );
    try {
      for (const [body, status, calls] of [
        ["hello!", 413, 0],
        ["hello", 413, 1],
        ["abc", 200, 2],
      ] as const) {
        const response = await fetch(`${server.url}body`, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body,
        });
        expect(response.status).toBe(status);
        await response.text();
        expect(entered).toBe(calls);
      }
      const rejected = await fetch(`${server.url}missing`, { method: "POST", body: "hello!" });
      expect(rejected.status).toBe(413);
      await rejected.text();
      expect(entered).toBe(2);
    } finally {
      await server.stop(true);
    }
  });

  test("ambiguous framing, chunked bodies, and pipelines retain byte limits", async () => {
    const server = createBunServer(echoRouter(), { port: 0, hostname: "127.0.0.1" });
    try {
      for (const [headers, body] of [
        ["Content-Length: 6", "hello!"],
        ["Transfer-Encoding: chunked", "6\r\nhello!\r\n0\r\n\r\n"],
        ["Content-Length: 1\r\nTransfer-Encoding: chunked", "6\r\nhello!\r\n0\r\n\r\n"],
        ["Content-Length: 6\r\nContent-Length: 6", "hello!"],
        ["Content-Length: 1\r\nContent-Length: 6", "hello!"],
        ["Content-Length: 6\r\nContent-Length: 1", "hello!"],
        ["Content-Length: +6", "hello!"],
        ["Content-Length: 0006", "hello!"],
        ["Content-Length: \t6 ", "hello!"],
      ]) {
        const response = await rawHttp(
          server.port!,
          `POST /body HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\n${headers}\r\nConnection: close\r\n\r\n${body}`,
        );
        if (/^HTTP\/1\.1 200 /u.test(response)) {
          expect(response.split("\r\n\r\n")[1]).not.toBe("hello!");
          expect(response).toContain("Content-Length: 1");
        } else expect(response).toMatch(/^HTTP\/1\.1 (400|413) /u);
      }
      const pipeline = await rawHttp(
        server.port!,
        "POST /body HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\nContent-Length: 1\r\n\r\nh" +
          "POST /body HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc",
      );
      expect(pipeline.match(/HTTP\/1\.1 200 /gu)).toHaveLength(2);
      expect(pipeline).toContain("\r\n\r\nhHTTP/1.1 200 ");
      expect(pipeline.endsWith("\r\n\r\nabc")).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("context replacement, middleware, and error boundaries run on native routes", async () => {
    const calls: string[] = [];
    const failing = operation("/error");
    const router = createHttpRouter(
      [
        bindRoute(failing, (_input, context) => {
          calls.push(context.request.headers.get("x-context")!);
          throw new Error("handler failure");
        }),
      ],
      {
        middleware: [
          (next) => async (context) => {
            calls.push("middleware");
            return next(context);
          },
        ],
        createContext: (request, match) => {
          const replacement = new Request(request, { headers: { "x-context": "replacement" } });
          return {
            request: replacement,
            match,
            state: {
              get() {
                return undefined;
              },
              set() {},
            },
          };
        },
        onUnhandledError: (error) => new Response((error as Error).message, { status: 503 }),
      },
    );
    const server = createBunServer(router, {
      port: 0,
      hostname: "127.0.0.1",
      logger: silentLogger,
    });
    try {
      const response = await fetch(`${server.url}error`);
      expect(response.status).toBe(503);
      expect(await response.text()).toBe("handler failure");
      expect(calls).toEqual(["middleware", "replacement"]);
    } finally {
      await server.stop(true);
    }
  });

  test.each([true, false])("logs unexpected failures with native routing %s", async (native) => {
    let failure: unknown;
    const failing = operation("/error");
    const handler = () => {
      throw new Error("failure");
    };
    const router = native
      ? createHttpRouter([bindRoute(failing, handler)])
      : { handle: async () => handler() };
    const server = createBunServer(router, {
      port: 0,
      hostname: "127.0.0.1",
      logger: {
        ...silentLogger,
        error(_message, fields) {
          failure = fields;
        },
      },
    });
    try {
      const response = await fetch(`${server.url}error`);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Internal Server Error");
      expect(failure).toMatchObject({ error: new Error("failure") });
      expect("fetch" in server).toBe(false);
      expect("reload" in server).toBe(false);
      expect(server.hostname).toBe("127.0.0.1");
      expect(server.pendingRequests).toBe(0);
      server.unref();
      server.ref();
    } finally {
      await server.stop(true);
    }
  });
});
