import assert from "node:assert/strict";
import { createServer } from "node:http";
import { toNodeHandler } from "@typespex/shim-node";

const encoder = new TextEncoder();
const responseChunks = ["streamed ", "response"];

const router = {
  async handle(request) {
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
};

const server = createServer(toNodeHandler(router));
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  assert(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/smoke`, {
    method: "POST",
    body: "request body",
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("content-type"), "text/plain");
  assert.equal(await response.text(), responseChunks.join(""));
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
