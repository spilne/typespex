import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { toNodeHandler } from "@typespex/shim-node";
import { Decoders, createHttpRouter, decodeBody, emptyHints } from "@typespex/runtime/server";

const encoder = new TextEncoder();
const silentLogger = {
  error() {},
  warn() {},
  info() {},
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withTimeout(promise, description) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), 2_000);
    }),
  ]).finally(() => clearTimeout(timer));
}

function waitForAbort(signal) {
  if (signal.aborted) return Promise.resolve(signal.reason);
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(signal.reason), { once: true });
  });
}

async function withServer(handle, run) {
  const sockets = new Set();
  const server = createServer(toNodeHandler({ handle }, { logger: silentLogger }));
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off("listening", onListening);
      server.off("error", onError);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address();
  assert(address && typeof address === "object");
  try {
    await run(address.port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function openClient(port, request) {
  const socket = connect({ host: "127.0.0.1", port });
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
  socket.write(request);
  return socket;
}

function resetClient(socket) {
  if (typeof socket.resetAndDestroy === "function") socket.resetAndDestroy();
  else socket.destroy();
}

function waitForText(socket, expected) {
  return new Promise((resolve, reject) => {
    let received = "";
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (chunk) => {
      received += chunk.toString("utf8");
      if (received.includes(expected)) {
        cleanup();
        resolve(received);
      }
    };
    const onError = (error) => {
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

function readToEnd(socket) {
  return new Promise((resolve, reject) => {
    let received = "";
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    const onData = (chunk) => {
      received += chunk.toString("utf8");
    };
    const onEnd = () => {
      cleanup();
      resolve(received);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
  });
}

async function testRequestAndResponseStreaming() {
  const responseChunks = ["streamed ", "response"];
  await withServer(
    async (request) => {
      assert.equal(request.method, "POST");
      assert.equal(await request.text(), "request body");

      let index = 0;
      const body = new ReadableStream({
        pull(controller) {
          if (index === responseChunks.length) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(responseChunks[index++]));
        },
      });

      return new Response(body, {
        status: 201,
        headers: { "content-type": "text/plain" },
      });
    },
    async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/smoke`, {
        method: "POST",
        body: "request body",
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(response.status, 201);
      assert.equal(response.headers.get("content-type"), "text/plain");
      assert.equal(await response.text(), responseChunks.join(""));
    },
  );
}

async function testBodylessSlowHandlerDisconnect() {
  const requestSeen = deferred();
  await withServer(
    async (request) => {
      requestSeen.resolve(request);
      await waitForAbort(request.signal);
      return new Response("client already left");
    },
    async (port) => {
      const socket = await openClient(
        port,
        "GET /slow HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      );
      try {
        const request = await withTimeout(requestSeen.promise, "the bodyless request handler");
        assert.equal(request.signal.aborted, false);
        resetClient(socket);
        const reason = await withTimeout(
          waitForAbort(request.signal),
          "the bodyless request abort",
        );
        assert(reason instanceof Error);
        assert.equal(request.signal.aborted, true);
      } finally {
        socket.destroy();
      }
    },
  );
}

async function testDisconnectAfterRequestBodyCompletion() {
  const bodyRead = deferred();
  await withServer(
    async (request) => {
      const body = await request.text();
      const aborted = waitForAbort(request.signal);
      bodyRead.resolve({ request, body });
      await aborted;
      return new Response("client already left");
    },
    async (port) => {
      const socket = await openClient(
        port,
        [
          "POST /upload HTTP/1.1",
          "Host: localhost",
          "Connection: close",
          "Content-Length: 7",
          "",
          "payload",
        ].join("\r\n"),
      );
      try {
        const completed = await withTimeout(bodyRead.promise, "the completed request body");
        assert.equal(completed.body, "payload");
        assert.equal(completed.request.signal.aborted, false);
        resetClient(socket);
        await withTimeout(waitForAbort(completed.request.signal), "the post-body request abort");
        assert.equal(completed.request.signal.aborted, true);
      } finally {
        socket.destroy();
      }
    },
  );
}

async function testIdleResponseCancellation() {
  const requestSeen = deferred();
  const responseCancelled = deferred();
  let cancellationCount = 0;
  await withServer(
    async (request) => {
      requestSeen.resolve(request);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("first chunk"));
          },
          cancel(reason) {
            cancellationCount++;
            responseCancelled.resolve(reason);
          },
        }),
      );
    },
    async (port) => {
      const socket = await openClient(
        port,
        "GET /events HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      );
      try {
        const responseText = waitForText(socket, "first chunk");
        const request = await withTimeout(requestSeen.promise, "the streaming request");
        await withTimeout(responseText, "the first response chunk");
        assert.equal(request.signal.aborted, false);
        resetClient(socket);
        const cancellationReason = await withTimeout(
          responseCancelled.promise,
          "the idle response cancellation",
        );
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(request.signal.aborted, true);
        assert.equal(cancellationReason, request.signal.reason);
        assert.equal(cancellationCount, 1);
      } finally {
        socket.destroy();
      }
    },
  );
}

async function testNormalCompletionDoesNotAbortOrCancel() {
  const requestSeen = deferred();
  let abortCount = 0;
  let cancellationCount = 0;
  await withServer(
    async (request) => {
      requestSeen.resolve(request);
      request.signal.addEventListener("abort", () => abortCount++);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("complete"));
            controller.close();
          },
          cancel() {
            cancellationCount++;
          },
        }),
      );
    },
    async (port) => {
      const socket = await openClient(
        port,
        "GET /complete HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      );
      try {
        const request = await withTimeout(requestSeen.promise, "the completed request");
        const response = await withTimeout(readToEnd(socket), "the completed response");
        await new Promise((resolve) => setImmediate(resolve));
        assert.match(response, /complete/);
        assert.equal(request.signal.aborted, false);
        assert.equal(abortCount, 0);
        assert.equal(cancellationCount, 0);
      } finally {
        socket.destroy();
      }
    },
  );
}

function createBodyLimitRouter() {
  const operation = {
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
      return decodeBody(request, { text: Decoders.string }, { contentTypes: ["text/plain"] });
    },
    encodeResult(result) {
      return new Response(result);
    },
  };
  return createHttpRouter(
    [
      {
        operation,
        async handler(input) {
          return input;
        },
      },
    ],
    { maxRequestBodyBytes: 5 },
  );
}

async function exchangeRawRequest(port, request) {
  const socket = await openClient(port, request);
  try {
    return await withTimeout(readToEnd(socket), "the body-limit response");
  } finally {
    socket.destroy();
  }
}

async function testFixedAndChunkedBodyLimits() {
  const router = createBodyLimitRouter();
  await withServer(
    (request) => router.handle(request),
    async (port) => {
      const fixedExact = await exchangeRawRequest(
        port,
        [
          "POST /body HTTP/1.1",
          "Host: localhost",
          "Connection: close",
          "Content-Type: text/plain",
          "Content-Length: 5",
          "",
          "hello",
        ].join("\r\n"),
      );
      assert.match(fixedExact, /^HTTP\/1\.1 200 /);
      assert.match(fixedExact, /hello/);

      const fixedOver = await exchangeRawRequest(
        port,
        [
          "POST /body HTTP/1.1",
          "Host: localhost",
          "Connection: close",
          "Content-Type: text/plain",
          "Content-Length: 6",
          "",
          "hello!",
        ].join("\r\n"),
      );
      assert.match(fixedOver, /^HTTP\/1\.1 413 /);
      assert.match(fixedOver, /"error":"Content Too Large"/);
      assert.match(fixedOver, /"maxBytes":5/);

      const chunkedExact = await exchangeRawRequest(
        port,
        [
          "POST /body HTTP/1.1",
          "Host: localhost",
          "Connection: close",
          "Content-Type: text/plain",
          "Transfer-Encoding: chunked",
          "",
          "2",
          "he",
          "3",
          "llo",
          "0",
          "",
          "",
        ].join("\r\n"),
      );
      assert.match(chunkedExact, /^HTTP\/1\.1 200 /);
      assert.match(chunkedExact, /hello/);

      const chunkedOver = await exchangeRawRequest(
        port,
        [
          "POST /body HTTP/1.1",
          "Host: localhost",
          "Connection: close",
          "Content-Type: text/plain",
          "Transfer-Encoding: chunked",
          "",
          "3",
          "hel",
          "3",
          "lo!",
          "0",
          "",
          "",
        ].join("\r\n"),
      );
      assert.match(chunkedOver, /^HTTP\/1\.1 413 /);
      assert.match(chunkedOver, /"error":"Content Too Large"/);
      assert.match(chunkedOver, /"maxBytes":5/);
    },
  );
}

await testRequestAndResponseStreaming();
await testBodylessSlowHandlerDisconnect();
await testDisconnectAfterRequestBodyCompletion();
await testIdleResponseCancellation();
await testNormalCompletionDoesNotAbortOrCancel();
await testFixedAndChunkedBodyLimits();
