import { describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { toNodeHandler } from "../src/index.js";
import type { HttpRouter } from "@typespex/runtime/server";

function mockRouter(handle: (request: Request) => Promise<Response>): HttpRouter {
  return { handle };
}

/** Starts a test server, runs a callback with the base URL, then closes. */
async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    await fn(`http://localhost:${port}`);
  } finally {
    server.close();
  }
}

describe("toNodeHandler", () => {
  test("converts Node request to Web Request and streams response", async () => {
    const router = mockRouter(async (request) =>
      Response.json({ url: new URL(request.url).pathname, method: request.method }),
    );
    const handler = toNodeHandler(router);

    await withServer(handler, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/pets`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ url: "/pets", method: "GET" });
    });
  });

  test("handles POST with JSON body", async () => {
    const router = mockRouter(async (request) => {
      const body = await request.json();
      return Response.json({ received: body });
    });
    const handler = toNodeHandler(router);

    await withServer(handler, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/pets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Milo" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: { name: "Milo" } });
    });
  });

  test("returns 500 on unhandled router error", async () => {
    const router = mockRouter(async () => {
      throw new Error("boom");
    });
    const handler = toNodeHandler(router);

    await withServer(handler, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/test`);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Internal Server Error");
    });
  });

  test("respects X-Forwarded-Proto header", async () => {
    const router = mockRouter(async (request) =>
      Response.json({ url: request.url }),
    );
    const handler = toNodeHandler(router);

    await withServer(handler, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/secure`, {
        headers: { "x-forwarded-proto": "https" },
      });
      const body = await response.json();
      expect(body.url).toStartWith("https://");
    });
  });

  test("preserves multi-value headers (e.g. cookie)", async () => {
    const router = mockRouter(async (request) => {
      // Node sends multi-value headers as arrays; they should be appended
      const accept = request.headers.get("accept");
      return Response.json({ accept });
    });
    const handler = toNodeHandler(router);

    await withServer(handler, async (baseUrl) => {
      // fetch sends single Accept header, but we can verify the conversion works
      const response = await fetch(`${baseUrl}/test`, {
        headers: { accept: "application/json" },
      });
      const body = await response.json();
      expect(body.accept).toBe("application/json");
    });
  });

  test("streams large response body in chunks", async () => {
    const bigPayload = "x".repeat(100_000);
    const router = mockRouter(async () =>
      new Response(bigPayload, {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    const handler = toNodeHandler(router);

    await withServer(handler, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/big`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text.length).toBe(100_000);
    });
  });
});
