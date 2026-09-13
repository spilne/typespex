import { describe, expect, test } from "bun:test";
import { createConnection } from "node:net";
import { gzipSync } from "node:zlib";
import { toBunHandler } from "../src/index.js";
import {
  bindRoute,
  createHttpRouter,
  decodeBody,
  Decoders,
  emptyHints,
  handleRequestWithTransport,
  type HttpRouter,
  type ServerOperation,
} from "@typespex/http-server";

const silentLogger = {
  error() {},
  warn() {},
  info() {},
};

function mockRouter(handle: (request: Request) => Promise<Response>): HttpRouter {
  return { handle, tryHandle: handle };
}

function bodyRouter(
  decoderLimit?: number | false,
  maximum = 5,
  decodedRequests?: Request[],
): HttpRouter {
  const operation: ServerOperation<string, string> = {
    endpoint: {
      service: { name: "BodyService", hints: emptyHints() },
      namespaces: [],
      operation: {
        name: "echo",
        operationId: "Body.echo",
        method: "POST",
        path: "/body",
        hints: emptyHints(),
      },
    },
    decodeInput(request) {
      decodedRequests?.push(request);
      return decodeBody(
        request,
        { text: Decoders.string },
        {
          contentTypes: ["text/plain"],
          maxRequestBodyBytes: decoderLimit,
        },
      );
    },
    encodeResult: (value) => new Response(value),
  };
  return createHttpRouter([bindRoute(operation, (value) => value)], {
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

describe("toBunHandler", () => {
  test("native transport handling cannot bypass spread, inherited, or replaced handle guards", async () => {
    for (const wrapping of ["spread", "inherited", "replaced"] as const) {
      const base = bodyRouter();
      const originalHandle = base.handle;
      const guardedHandle = (request: Request) =>
        request.headers.has("authorization")
          ? originalHandle(request)
          : Promise.resolve(new Response("Unauthorized", { status: 401 }));
      const router =
        wrapping === "spread"
          ? { ...base, handle: guardedHandle }
          : wrapping === "inherited"
            ? (Object.assign(Object.create(base), { handle: guardedHandle }) as HttpRouter)
            : base;
      const handler = toBunHandler(router, { logger: silentLogger });
      if (wrapping === "replaced") router.handle = guardedHandle;
      const server = Bun.serve({ port: 0, hostname: "127.0.0.1", ...handler });
      try {
        const url = `http://127.0.0.1:${server.port}/body`;
        const denied = await fetch(url, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "hello",
        });
        expect(denied.status).toBe(401);
        await denied.text();
        const allowed = await fetch(url, {
          method: "POST",
          headers: { "content-type": "text/plain", authorization: "test" },
          body: "hello",
        });
        expect(allowed.status).toBe(200);
        expect(await allowed.text()).toBe("hello");
      } finally {
        await server.stop(true);
      }
    }
  });

  test("native framing conflicts cannot admit an oversized body", async () => {
    const router = bodyRouter();
    const handler = toBunHandler(router, { logger: silentLogger });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", ...handler });
    try {
      for (const [headers, body] of [
        ["Content-Length: 6", "hello!"],
        ["Content-Length: 1\r\nTransfer-Encoding: chunked", "6\r\nhello!\r\n0\r\n\r\n"],
        ["Content-Length: 6\r\nContent-Length: 6", "hello!"],
        ["Content-Length: 1\r\nContent-Length: 6", "hello!"],
        ["Content-Length: 6\r\nContent-Length: 1", "hello!"],
        ["Content-Length: +6", "hello!"],
        ["Content-Length: 0006", "hello!"],
        ["Content-Length: \t6 ", "hello!"],
      ]) {
        const response = await rawHttp(
          server.port,
          `POST /body HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\n${headers}\r\nConnection: close\r\n\r\n${body}`,
        );
        // A parser may reject ambiguous framing or honor only its selected
        // length. It must never return the six-byte body through a five-byte limit.
        if (/^HTTP\/1\.1 200 /u.test(response)) {
          expect(response.split("\r\n\r\n")[1]).not.toBe("hello!");
          expect(response).toContain("Content-Length: 1");
        } else {
          expect(response).toMatch(/^HTTP\/1\.1 (400|413) /u);
        }
      }
      const pipelined = await rawHttp(
        server.port,
        "POST /body HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\nContent-Length: 1\r\n\r\nh" +
          "POST /body HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc",
      );
      expect(pipelined.match(/HTTP\/1\.1 200 /gu)).toHaveLength(2);
      expect(pipelined).toContain("\r\n\r\nhHTTP/1.1 200 ");
      expect(pipelined.endsWith("\r\n\r\nabc")).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("verified length applies to gzip wire bytes without implicit decompression", async () => {
    const body = gzipSync("a".repeat(1000));
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      ...toBunHandler(bodyRouter(undefined, body.byteLength), { logger: silentLogger }),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/body`, {
        method: "POST",
        headers: { "content-type": "text/plain", "content-encoding": "gzip" },
        body,
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(new TextDecoder().decode(body));
    } finally {
      await server.stop(true);
    }
  });

  test("ignores non-Bun callback context and preserves legacy router arguments", async () => {
    const request = () =>
      new Request("http://localhost/body", {
        method: "POST",
        headers: { "content-type": "text/plain", "content-length": "5" },
        body: "hello",
      });
    const handler = toBunHandler(bodyRouter(), { logger: silentLogger });
    for (const context of [1, { env: "worker" }, { requestIP: "not a function" }]) {
      const response = await handler.fetch(request(), context);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("hello");
    }

    let receivedOptions: unknown = "not called";
    const legacy = toBunHandler({
      async handle(request: Request, options?: { parsedBody?: unknown }) {
        receivedOptions = options;
        return new Response(await request.text());
      },
    });
    const response = await legacy.fetch(request(), { requestIP: () => ({ address: "127.0.0.1" }) });
    expect(await response.text()).toBe("hello");
    expect(receivedOptions).toBeUndefined();
  });

  test("transport facts cannot be forwarded with a replaced request body", async () => {
    const original = new Request("http://localhost/body", { method: "POST", body: "hello" });
    const replacement = new Request("http://localhost/body", {
      method: "POST",
      headers: { "content-type": "text/plain", "content-length": "5" },
      body: "hello!",
    });
    const router = bodyRouter();
    const response = await handleRequestWithTransport(router, replacement, {
      request: original,
      verifiedBodyLength: 5,
    });
    expect(response.status).toBe(413);
    await response.text();
  });

  test("native fixed-length requests keep body limits and other requests retain counting", async () => {
    const decodedRequests: Request[] = [];
    const nativeRequests: Request[] = [];
    const handler = toBunHandler(bodyRouter(undefined, 5, decodedRequests), {
      logger: silentLogger,
    });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request, server) {
        nativeRequests.push(request);
        return handler.fetch(request, server);
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}/body`;
      const exact = await fetch(url, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "hello",
      });
      expect(exact.status).toBe(200);
      expect(await exact.text()).toBe("hello");
      expect(decodedRequests[0]).toBe(nativeRequests[0]);

      const over = await fetch(url, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "hello!",
      });
      expect(over.status).toBe(413);
      expect(await over.json()).toEqual({ error: "Content Too Large", maxBytes: 5 });

      const chunked = await fetch(url, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("hello"));
            controller.enqueue(new Uint8Array([33]));
            controller.close();
          },
        }),
      });
      expect(chunked.status).toBe(413);
      await chunked.text();

      const synthetic = new Request(url, {
        method: "POST",
        headers: { "content-type": "text/plain", "content-length": "1" },
        body: "hello!",
      });
      const fake = await handler.fetch(synthetic, server);
      expect(fake.status).toBe(413);
      await fake.text();

      const internal = await server.fetch(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "text/plain", "content-length": "1" },
          body: "hello!",
        }),
      );
      expect(internal.status).toBe(413);
      await internal.text();

      // Manual calls after header changes omit the native server argument.
      const manual = await handler.fetch(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "text/plain", "content-length": "1" },
          body: "hello!",
        }),
      );
      expect(manual.status).toBe(413);
      await manual.text();
      expect(decodedRequests[1]).not.toBe(nativeRequests[2]);
    } finally {
      await server.stop(true);
    }
  });

  test("cloned native requests retain streamed counting", async () => {
    const handler = toBunHandler(bodyRouter(), { logger: silentLogger });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request, server) {
        const clone = request.clone();
        clone.headers.set("content-length", "1");
        return handler.fetch(clone, server);
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/body`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "hello!",
      });
      expect(response.status).toBe(413);
      await response.text();
    } finally {
      await server.stop(true);
    }
  });

  test("a decoder can tighten the verified native request limit", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      ...toBunHandler(bodyRouter(4), { logger: silentLogger }),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/body`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "hello",
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: "Content Too Large", maxBytes: 4 });
    } finally {
      await server.stop(true);
    }
  });

  test("passes request through and returns response", async () => {
    const router = mockRouter(async (request) =>
      Response.json({ url: request.url, method: request.method }),
    );
    const handler = toBunHandler(router, { logger: silentLogger });

    const response = await handler.fetch(new Request("http://localhost/test"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: "http://localhost/test",
      method: "GET",
    });
  });

  test("returns 404 from router for unmatched routes", async () => {
    const router = mockRouter(async () => Response.json({ error: "Not Found" }, { status: 404 }));
    const handler = toBunHandler(router, { logger: silentLogger });

    const response = await handler.fetch(new Request("http://localhost/unknown"));
    expect(response.status).toBe(404);
  });

  test("returns 500 on unhandled router error", async () => {
    const router = mockRouter(async () => {
      throw new Error("boom");
    });
    const handler = toBunHandler(router, { logger: silentLogger });

    const response = await handler.fetch(new Request("http://localhost/test"));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
  });
});
