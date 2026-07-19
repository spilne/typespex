import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { toNodeHandler } from "../src/index.js";
import type { HttpRouter } from "@typespex/runtime/server";

function mockRouter(handle: (request: Request) => Promise<Response>): HttpRouter {
  return { handle, tryHandle: handle };
}

const silentLogger = {
  error() {},
  warn() {},
  info() {},
};

interface MockRequestOptions {
  readonly method?: string;
  readonly url: string;
  readonly headers?: IncomingMessage["headers"];
  readonly body?: string;
  readonly bodyChunks?: readonly (Buffer | string)[];
  readonly onBodyChunkRead?: () => void;
  readonly waitForRequestEnd?: boolean;
  readonly simulateBackpressure?: boolean;
  readonly onRequest?: (request: IncomingMessage) => void;
}

interface MockResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly setCookies: readonly string[];
  readonly body: string;
  readonly destroyed: boolean;
}

async function invokeHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  options: MockRequestOptions,
): Promise<MockResponse> {
  const requestChunks = options.bodyChunks
    ? options.bodyChunks.map((chunk) => (typeof chunk === "string" ? Buffer.from(chunk) : chunk))
    : options.body === undefined
      ? []
      : [Buffer.from(options.body)];
  const req = Readable.from(
    (function* () {
      for (const chunk of requestChunks) {
        options.onBodyChunkRead?.();
        yield chunk;
      }
    })(),
  ) as IncomingMessage;
  req.method = options.method ?? "GET";
  req.url = options.url;
  req.headers = {
    host: "localhost",
    ...options.headers,
  };
  options.onRequest?.(req);
  if (
    requestChunks.length > 0 &&
    req.headers["content-length"] === undefined &&
    req.headers["transfer-encoding"] === undefined
  ) {
    req.headers["content-length"] = String(
      requestChunks.reduce((length, chunk) => length + chunk.byteLength, 0),
    );
  }

  const requestEnded = options.waitForRequestEnd
    ? new Promise<void>((resolve, reject) => {
        req.once("end", resolve);
        req.once("error", reject);
      })
    : undefined;

  const headers = new Headers();
  let setCookies: readonly string[] = [];
  const chunks: Buffer[] = [];
  let backpressurePending = options.simulateBackpressure ?? false;
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    setHeader(name: string, value: number | string | readonly string[]) {
      if (name.toLowerCase() === "set-cookie") {
        setCookies = Array.isArray(value) ? value.map(String) : [String(value)];
        return this;
      }
      headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
      return this;
    },
    getHeaderNames() {
      const names: string[] = [];
      headers.forEach((_value, name) => names.push(name));
      if (setCookies.length > 0) names.push("set-cookie");
      return names;
    },
    removeHeader(name: string) {
      if (name.toLowerCase() === "set-cookie") setCookies = [];
      else headers.delete(name);
    },
    write(chunk: Uint8Array | string) {
      this.headersSent = true;
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
      if (backpressurePending) {
        backpressurePending = false;
        queueMicrotask(() => this.emit("drain"));
        return false;
      }
      return true;
    },
    end(chunk?: Uint8Array | string) {
      this.headersSent = true;
      this.writableEnded = true;
      if (chunk !== undefined) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
      }
      return this;
    },
    destroy() {
      this.destroyed = true;
      return this;
    },
  }) as unknown as ServerResponse;

  await (handler(req, res) as unknown as Promise<void>);
  if (requestEnded) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      requestEnded,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("request body did not drain")), 500);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  return {
    status: res.statusCode,
    headers,
    setCookies,
    body: Buffer.concat(chunks).toString("utf8"),
    destroyed: res.destroyed,
  };
}

describe("toNodeHandler", () => {
  test("converts Node request to Web Request and streams response", async () => {
    const router = mockRouter(async (request) =>
      Response.json({ url: new URL(request.url).pathname, method: request.method }),
    );
    const handler = toNodeHandler(router);

    const response = await invokeHandler(handler, { url: "/pets" });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ url: "/pets", method: "GET" });
  });

  test("handles POST with JSON body", async () => {
    const router = mockRouter(async (request) => {
      const body = await request.json();
      return Response.json({ received: body });
    });
    const handler = toNodeHandler(router);

    const response = await invokeHandler(handler, {
      method: "POST",
      url: "/pets",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Milo" }),
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ received: { name: "Milo" } });
  });

  test("enqueues incoming Buffer chunks without copying them", async () => {
    const bodyChunk = Buffer.from("streamed body");
    let receivedChunk: Uint8Array | undefined;
    const router = mockRouter(async (request) => {
      receivedChunk = (await request.body!.getReader().read()).value;
      return new Response("ok");
    });

    await invokeHandler(toNodeHandler(router), {
      method: "POST",
      url: "/stream",
      bodyChunks: [bodyChunk],
    });

    expect(receivedChunk).toBe(bodyChunk);
  });

  test("does not consume the incoming body before application code reads it", async () => {
    let chunksRead = 0;
    let chunksReadBeforeBody = -1;
    const router = mockRouter(async (request) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      chunksReadBeforeBody = chunksRead;
      return Response.json({ body: await request.text() });
    });

    const response = await invokeHandler(toNodeHandler(router), {
      method: "POST",
      url: "/stream",
      bodyChunks: ["first", "second"],
      onBodyChunkRead() {
        chunksRead++;
      },
    });

    expect(chunksReadBeforeBody).toBe(0);
    expect(chunksRead).toBe(2);
    expect(JSON.parse(response.body)).toEqual({ body: "firstsecond" });
  });

  test("cancels an incoming body without emitting the cancellation reason as an error", async () => {
    let requestError: Error | undefined;
    let incomingRequest: IncomingMessage | undefined;
    const router = mockRouter(async (request) => {
      await request.body!.cancel(new Error("body no longer needed"));
      return new Response("ignored");
    });

    await invokeHandler(toNodeHandler(router), {
      method: "POST",
      url: "/cancel",
      body: "payload",
      onRequest(request) {
        incomingRequest = request;
        request.once("error", (error) => {
          requestError = error;
        });
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(incomingRequest?.destroyed).toBe(true);
    expect(requestError).toBeUndefined();
  });

  test("represents an unframed empty POST as a request without a body", async () => {
    const router = mockRouter(async (request) =>
      Response.json({ bodyAbsent: request.body === null }),
    );
    const handler = toNodeHandler(router);

    const response = await invokeHandler(handler, { method: "POST", url: "/optional" });

    expect(JSON.parse(response.body)).toEqual({ bodyAbsent: true });
  });

  test("drains an unread multi-chunk request body after writing the response", async () => {
    const router = mockRouter(async () => new Response("rejected", { status: 415 }));
    const response = await invokeHandler(toNodeHandler(router), {
      method: "POST",
      url: "/reject",
      bodyChunks: Array.from({ length: 32 }, () => "x".repeat(8 * 1024)),
      waitForRequestEnd: true,
    });

    expect(response.status).toBe(415);
    expect(response.body).toBe("rejected");
  });

  test("handles a client disconnect error while draining an unread request body", async () => {
    let drainErrorEmitted = false;
    const router = mockRouter(async () => new Response("rejected", { status: 415 }));

    const response = await invokeHandler(toNodeHandler(router), {
      method: "POST",
      url: "/reject",
      bodyChunks: Array.from({ length: 32 }, () => "x".repeat(8 * 1024)),
      onRequest(request) {
        const resume = request.resume.bind(request);
        request.resume = (() => {
          if (!drainErrorEmitted && request.listenerCount("data") === 0) {
            drainErrorEmitted = true;
            request.emit("error", new Error("client disconnected"));
          }
          return resume();
        }) as typeof request.resume;
      },
    });

    expect(drainErrorEmitted).toBe(true);
    expect(response.status).toBe(415);
    expect(response.body).toBe("rejected");
  });

  test("returns 500 on unhandled router error", async () => {
    const router = mockRouter(async () => {
      throw new Error("boom");
    });
    const handler = toNodeHandler(router, { logger: silentLogger });

    const response = await invokeHandler(handler, { url: "/test" });
    expect(response.status).toBe(500);
    expect(response.body).toBe("Internal Server Error");
  });

  test("clears staged response headers when streaming fails before the first chunk", async () => {
    const router = mockRouter(async () => {
      const headers = new Headers({
        "content-type": "application/json",
        "x-upstream": "should-not-leak",
      });
      headers.append("set-cookie", "session=abc; Path=/");
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("stream failed"));
          },
        }),
        { status: 201, headers },
      );
    });

    const response = await invokeHandler(toNodeHandler(router, { logger: silentLogger }), {
      url: "/stream-error",
    });

    expect(response.status).toBe(500);
    expect(response.body).toBe("Internal Server Error");
    expect([...response.headers]).toEqual([]);
    expect(response.setCookies).toEqual([]);
  });

  test("respects X-Forwarded-Proto when trustProxy is enabled", async () => {
    const router = mockRouter(async (request) => Response.json({ url: request.url }));
    const handler = toNodeHandler(router, { trustProxy: true });

    const response = await invokeHandler(handler, {
      url: "/secure",
      headers: { "x-forwarded-proto": "https" },
    });
    expect(JSON.parse(response.body).url).toStartWith("https://");
  });

  test("trusts the first repeated X-Forwarded-Proto value", async () => {
    const router = mockRouter(async (request) => Response.json({ url: request.url }));
    const handler = toNodeHandler(router, { trustProxy: true });

    const response = await invokeHandler(handler, {
      url: "/secure",
      headers: { "x-forwarded-proto": ["https", "http"] },
    });

    expect(JSON.parse(response.body).url).toStartWith("https://");
  });

  test("does not trust X-Forwarded-Proto by default", async () => {
    const router = mockRouter(async (request) => Response.json({ url: request.url }));
    const handler = toNodeHandler(router);

    const response = await invokeHandler(handler, {
      url: "/secure",
      headers: { "x-forwarded-proto": "https" },
    });

    expect(JSON.parse(response.body).url).toStartWith("http://");
  });

  test("uses HTTPS for an encrypted socket without trusting proxy headers", async () => {
    const router = mockRouter(async (request) => Response.json({ url: request.url }));
    const handler = toNodeHandler(router);

    const response = await invokeHandler(handler, {
      url: "/secure",
      onRequest(request) {
        Object.defineProperty(request, "socket", { value: { encrypted: true } });
      },
    });

    expect(JSON.parse(response.body).url).toStartWith("https://");
  });

  test("aborts the Request signal when the incoming body stream errors", async () => {
    const connectionError = new Error("connection reset");
    let incomingRequest: IncomingMessage | undefined;
    const router = mockRouter(async (request) => {
      incomingRequest!.emit("error", connectionError);
      return Response.json({
        aborted: request.signal.aborted,
        hasConnectionError: request.signal.reason === connectionError,
      });
    });

    const response = await invokeHandler(toNodeHandler(router), {
      method: "POST",
      url: "/upload",
      body: "payload",
      onRequest(request) {
        incomingRequest = request;
      },
    });

    expect(JSON.parse(response.body)).toEqual({ aborted: true, hasConnectionError: true });
  });

  test("preserves multiple Set-Cookie headers", async () => {
    const router = mockRouter(async () => {
      const headers = new Headers();
      headers.append("set-cookie", "session=abc; Path=/; HttpOnly");
      headers.append("set-cookie", "theme=dark; Path=/");
      return new Response(null, { headers });
    });
    const handler = toNodeHandler(router);

    const response = await invokeHandler(handler, { url: "/cookies" });

    expect(response.setCookies).toEqual(["session=abc; Path=/; HttpOnly", "theme=dark; Path=/"]);
    expect(response.headers.has("set-cookie")).toBe(false);
  });

  test("preserves Set-Cookie when Headers.getSetCookie is unavailable", async () => {
    const router = mockRouter(async () => {
      const response = new Response(null, {
        headers: { "set-cookie": "session=legacy; Path=/" },
      });
      Object.defineProperty(response.headers, "getSetCookie", { value: undefined });
      return response;
    });

    const response = await invokeHandler(toNodeHandler(router), { url: "/cookies" });

    expect(response.setCookies).toEqual(["session=legacy; Path=/"]);
    expect(response.headers.has("set-cookie")).toBe(false);
  });

  test("preserves multi-value headers (e.g. cookie)", async () => {
    const router = mockRouter(async (request) => {
      // Node sends multi-value headers as arrays; they should be appended
      const accept = request.headers.get("accept");
      return Response.json({ accept });
    });
    const handler = toNodeHandler(router);

    const response = await invokeHandler(handler, {
      url: "/test",
      headers: { accept: ["application/json", "text/plain"] },
    });
    expect(JSON.parse(response.body).accept).toBe("application/json, text/plain");
  });

  test("streams large response body in chunks", async () => {
    const bigPayload = "x".repeat(100_000);
    const router = mockRouter(
      async () =>
        new Response(bigPayload, {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );
    const handler = toNodeHandler(router);

    const response = await invokeHandler(handler, { url: "/big" });
    expect(response.status).toBe(200);
    expect(response.body.length).toBe(100_000);
  });

  test("waits for drain when the Node response applies backpressure", async () => {
    const router = mockRouter(async () => new Response("streamed"));
    const handler = toNodeHandler(router);

    const response = await invokeHandler(handler, {
      url: "/stream",
      simulateBackpressure: true,
    });

    expect(response.body).toBe("streamed");
  });

  test("destroys the connection when a response stream fails after headers are sent", async () => {
    const router = mockRouter(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
          setTimeout(() => controller.error(new Error("stream failed")), 0);
        },
      });
      return new Response(stream);
    });
    const handler = toNodeHandler(router, { logger: silentLogger });

    const response = await invokeHandler(handler, { url: "/stream-error" });

    expect(response.body).toBe("partial");
    expect(response.destroyed).toBe(true);
    expect(response.status).toBe(200);
  });
});
