import { describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { toNodeHandler } from "../src/index.js";
import type { HttpRouter } from "@typespex/runtime/server";

function mockRouter(handle: (request: Request) => Promise<Response>): HttpRouter {
  return { handle };
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
}

interface MockResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

async function invokeHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  options: MockRequestOptions,
): Promise<MockResponse> {
  const req = Readable.from(
    options.body === undefined ? [] : [Buffer.from(options.body)],
  ) as IncomingMessage;
  req.method = options.method ?? "GET";
  req.url = options.url;
  req.headers = {
    host: "localhost",
    ...options.headers,
  };

  const headers = new Headers();
  const chunks: Buffer[] = [];
  const res = {
    statusCode: 200,
    setHeader(name: string, value: number | string | readonly string[]) {
      headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
      return this;
    },
    write(chunk: Uint8Array | string) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
      return true;
    },
    end(chunk?: Uint8Array | string) {
      if (chunk !== undefined) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
      }
      return this;
    },
  } as unknown as ServerResponse;

  await (handler(req, res) as unknown as Promise<void>);

  return {
    status: res.statusCode,
    headers,
    body: Buffer.concat(chunks).toString("utf8"),
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

  test("returns 500 on unhandled router error", async () => {
    const router = mockRouter(async () => {
      throw new Error("boom");
    });
    const handler = toNodeHandler(router, { logger: silentLogger });

    const response = await invokeHandler(handler, { url: "/test" });
    expect(response.status).toBe(500);
    expect(response.body).toBe("Internal Server Error");
  });

  test("respects X-Forwarded-Proto header", async () => {
    const router = mockRouter(async (request) =>
      Response.json({ url: request.url }),
    );
    const handler = toNodeHandler(router);

    const response = await invokeHandler(handler, {
      url: "/secure",
      headers: { "x-forwarded-proto": "https" },
    });
    expect(JSON.parse(response.body).url).toStartWith("https://");
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
    const router = mockRouter(async () =>
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
});
