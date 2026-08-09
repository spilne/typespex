import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
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
  readonly onResponse?: (response: ServerResponse) => void;
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
  options.onResponse?.(res);

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

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withTimeout<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), 2_000);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function waitForAbort(signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return Promise.resolve(signal.reason);
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(signal.reason), { once: true });
  });
}

interface RealServer {
  readonly port: number;
  readonly close: () => Promise<void>;
}

async function startRealServer(router: HttpRouter): Promise<RealServer> {
  const sockets = new Set<Socket>();
  const server = createServer(toNodeHandler(router, { logger: silentLogger }));
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      server.off("listening", onListening);
      server.off("error", onError);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected the test server to listen on an ephemeral TCP port.");
  }

  return {
    port: address.port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function openRawClient(port: number, request: string): Promise<Socket> {
  const socket = connect({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
  socket.write(request);
  return socket;
}

function waitForSocketText(socket: Socket, expected: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = "";
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (chunk: Buffer) => {
      received += chunk.toString("utf8");
      if (received.includes(expected)) {
        cleanup();
        resolve(received);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`Socket closed before receiving ${JSON.stringify(expected)}.`));
    };

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function readSocketToEnd(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = "";
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    const onData = (chunk: Buffer) => {
      received += chunk.toString("utf8");
    };
    const onEnd = () => {
      cleanup();
      resolve(received);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
  });
}

function disconnectClient(socket: Socket): void {
  if (typeof socket.resetAndDestroy === "function") socket.resetAndDestroy();
  else socket.destroy();
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

  test("aborts a bodyless Request signal when a real client disconnects during a slow handler", async () => {
    const requestSeen = deferred<Request>();
    const router = mockRouter(async (request) => {
      requestSeen.resolve(request);
      await waitForAbort(request.signal);
      return new Response("client already left");
    });
    const server = await startRealServer(router);
    let socket: Socket | undefined;

    try {
      socket = await openRawClient(
        server.port,
        "GET /slow HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      );
      const request = await withTimeout(requestSeen.promise, "the bodyless request handler");
      expect(request.signal.aborted).toBe(false);

      disconnectClient(socket);
      const reason = await withTimeout(waitForAbort(request.signal), "the bodyless request abort");

      expect(request.signal.aborted).toBe(true);
      expect(reason).toBeInstanceOf(Error);
    } finally {
      socket?.destroy();
      await server.close();
    }
  });

  test("keeps disconnect tracking after the request body stream has completed", async () => {
    const bodyRead = deferred<{ readonly request: Request; readonly body: string }>();
    let outgoingResponse: ServerResponse | undefined;
    const router = mockRouter(async (request) => {
      const body = await request.text();
      const aborted = waitForAbort(request.signal);
      bodyRead.resolve({ request, body });
      await aborted;
      return new Response("client already left");
    });
    const handled = invokeHandler(toNodeHandler(router, { logger: silentLogger }), {
      method: "POST",
      url: "/upload",
      body: "payload",
      onResponse(response) {
        outgoingResponse = response;
      },
    });

    const completed = await withTimeout(bodyRead.promise, "the completed request body");
    expect(completed.body).toBe("payload");
    expect(completed.request.signal.aborted).toBe(false);

    outgoingResponse?.emit("close");
    await withTimeout(waitForAbort(completed.request.signal), "the post-body request abort");
    await handled;
    expect(completed.request.signal.aborted).toBe(true);
  });

  test("cancels an idle response stream once when a real client disconnects", async () => {
    const requestSeen = deferred<Request>();
    const responseCancelled = deferred<unknown>();
    let cancellationCount = 0;
    const router = mockRouter(async (request) => {
      requestSeen.resolve(request);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first chunk"));
          },
          cancel(reason) {
            cancellationCount++;
            responseCancelled.resolve(reason);
          },
        }),
      );
    });
    const server = await startRealServer(router);
    let socket: Socket | undefined;

    try {
      socket = await openRawClient(
        server.port,
        "GET /events HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      );
      const responseText = waitForSocketText(socket, "first chunk");
      const request = await withTimeout(requestSeen.promise, "the streaming request");
      await withTimeout(responseText, "the first response chunk");
      expect(request.signal.aborted).toBe(false);

      disconnectClient(socket);
      const cancellationReason = await withTimeout(
        responseCancelled.promise,
        "the idle response cancellation",
      );
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(request.signal.aborted).toBe(true);
      expect(cancellationReason).toBe(request.signal.reason);
      expect(cancellationCount).toBe(1);
    } finally {
      socket?.destroy();
      await server.close();
    }
  });

  test("cancels an idle response stream and cleans up when ServerResponse emits an error", async () => {
    const responseIdle = deferred<void>();
    const responseCancelled = deferred<unknown>();
    const connectionError = new Error("response connection failed");
    let requestSignal: AbortSignal | undefined;
    let outgoingResponse: ServerResponse | undefined;
    let responseCloseListeners = 0;
    let responseErrorListeners = 0;
    let cancellationCount = 0;
    let loggedErrors = 0;
    const router = mockRouter(async (request) => {
      requestSignal = request.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first chunk"));
          },
          pull() {
            responseIdle.resolve();
          },
          cancel(reason) {
            cancellationCount++;
            responseCancelled.resolve(reason);
          },
        }),
      );
    });
    const handled = invokeHandler(
      toNodeHandler(router, {
        logger: {
          ...silentLogger,
          error() {
            loggedErrors++;
          },
        },
      }),
      {
        url: "/events",
        onResponse(response) {
          outgoingResponse = response;
          responseCloseListeners = response.listenerCount("close");
          responseErrorListeners = response.listenerCount("error");
        },
      },
    );

    await withTimeout(responseIdle.promise, "the idle response reader");
    outgoingResponse?.emit("error", connectionError);
    const cancellationReason = await withTimeout(
      responseCancelled.promise,
      "the failed response cancellation",
    );
    await handled;

    expect(cancellationReason).toBe(connectionError);
    expect(requestSignal?.aborted).toBe(true);
    expect(requestSignal?.reason).toBe(connectionError);
    expect(cancellationCount).toBe(1);
    expect(loggedErrors).toBe(0);
    expect(outgoingResponse?.listenerCount("close")).toBe(responseCloseListeners);
    expect(outgoingResponse?.listenerCount("error")).toBe(responseErrorListeners);
  });

  test("does not abort or cancel a normally completed real-socket request", async () => {
    const requestSeen = deferred<Request>();
    let abortCount = 0;
    let cancellationCount = 0;
    const router = mockRouter(async (request) => {
      requestSeen.resolve(request);
      request.signal.addEventListener("abort", () => abortCount++);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("complete"));
            controller.close();
          },
          cancel() {
            cancellationCount++;
          },
        }),
      );
    });
    const server = await startRealServer(router);
    let socket: Socket | undefined;

    try {
      socket = await openRawClient(
        server.port,
        "GET /complete HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      );
      const request = await withTimeout(requestSeen.promise, "the completed request");
      const response = await withTimeout(readSocketToEnd(socket), "the completed response");
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(response).toContain("complete");
      expect(request.signal.aborted).toBe(false);
      expect(abortCount).toBe(0);
      expect(cancellationCount).toBe(0);
    } finally {
      socket?.destroy();
      await server.close();
    }
  });

  test("removes lifecycle listeners after a completed request", async () => {
    const socket = new EventEmitter();
    let incomingRequest: IncomingMessage | undefined;
    let outgoingResponse: ServerResponse | undefined;
    let requestAbortedListeners = 0;
    let requestErrorListeners = 0;
    let responseCloseListeners = 0;
    let responseErrorListeners = 0;
    const socketCloseListeners = socket.listenerCount("close");
    const socketErrorListeners = socket.listenerCount("error");

    await invokeHandler(toNodeHandler(mockRouter(async () => new Response("ok"))), {
      url: "/complete",
      onRequest(request) {
        Object.defineProperty(request, "socket", { value: socket });
        incomingRequest = request;
        requestAbortedListeners = request.listenerCount("aborted");
        requestErrorListeners = request.listenerCount("error");
      },
      onResponse(response) {
        outgoingResponse = response;
        responseCloseListeners = response.listenerCount("close");
        responseErrorListeners = response.listenerCount("error");
      },
    });

    expect(incomingRequest?.listenerCount("aborted")).toBe(requestAbortedListeners);
    expect(incomingRequest?.listenerCount("error")).toBe(requestErrorListeners);
    expect(outgoingResponse?.listenerCount("close")).toBe(responseCloseListeners);
    expect(outgoingResponse?.listenerCount("error")).toBe(responseErrorListeners);
    expect(socket.listenerCount("close")).toBe(socketCloseListeners);
    expect(socket.listenerCount("error")).toBe(socketErrorListeners);
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
