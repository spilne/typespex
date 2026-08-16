import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { toExpressHandler } from "@typespex/adapter-express";

const app = express();
app.use(
  "/api",
  toExpressHandler({
    async handle(request) {
      const url = new URL(request.url);
      return Response.json({
        method: request.method,
        path: url.pathname,
        query: url.searchParams.get("expand"),
        requestId: request.headers.get("x-request-id"),
        body: await request.json(),
      });
    },
  }),
);

const server = app.listen(0, "127.0.0.1");
await once(server, "listening");

try {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/widgets/w-7?expand=true`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": "node-smoke",
    },
    body: JSON.stringify({ name: "sample" }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    method: "POST",
    path: "/widgets/w-7",
    query: "true",
    requestId: "node-smoke",
    body: { name: "sample" },
  });
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
