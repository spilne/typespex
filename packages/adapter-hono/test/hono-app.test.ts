import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { toHonoApp, toHonoMiddleware } from "../src/index.js";
import type { ComposableHttpRouter, HttpRouter } from "@typespex/http-server";

function mockRouter(
  handle: (request: Request) => Promise<Response>,
  tryHandle: (request: Request) => Promise<Response | undefined> = handle,
): ComposableHttpRouter {
  return { handle, tryHandle };
}

describe("toHonoApp", () => {
  test("delegates all requests to the router", async () => {
    const router: HttpRouter = {
      handle: async (request) => Response.json({ path: new URL(request.url).pathname }),
    };
    const app = toHonoApp(router);

    const response = await app.fetch(new Request("http://localhost/pets"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: "/pets" });
  });

  test("handles POST with body", async () => {
    const router = mockRouter(async (request) => {
      const body = await request.json();
      return Response.json({ received: body });
    });
    const app = toHonoApp(router);

    const response = await app.fetch(
      new Request("http://localhost/pets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Milo" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: { name: "Milo" } });
  });

  test("returns 404 from router for unmatched routes", async () => {
    const router = mockRouter(async () => Response.json({ error: "Not Found" }, { status: 404 }));
    const app = toHonoApp(router);

    const response = await app.fetch(new Request("http://localhost/unknown"));
    expect(response.status).toBe(404);
  });

  test("delegates unhandled router errors to Hono", async () => {
    const failure = new Error("boom");
    let observed: unknown;
    const router = mockRouter(async () => {
      throw failure;
    });
    const app = toHonoApp(router);
    app.onError((error, c) => {
      observed = error;
      return c.text("hono error boundary", 598);
    });

    const response = await app.fetch(new Request("http://localhost/test"));
    expect(response.status).toBe(598);
    expect(await response.text()).toBe("hono error boundary");
    expect(observed).toBe(failure);
  });
});

describe("toHonoMiddleware", () => {
  test("handles requests matched by the TypeSpec router", async () => {
    const router = mockRouter(
      async () => new Response("unused"),
      async (request) => {
        const pathname = new URL(request.url).pathname;
        return pathname === "/pets" ? Response.json({ source: "typespex" }) : undefined;
      },
    );
    const app = new Hono();
    app.use("*", toHonoMiddleware(router));
    app.get("/health", (c) => c.json({ source: "hono" }));

    const response = await app.fetch(new Request("http://localhost/pets"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ source: "typespex" });
  });

  test("falls through to user-defined Hono routes when no operation matches", async () => {
    const router = mockRouter(
      async () => new Response("unused"),
      async () => undefined,
    );
    const app = new Hono();
    app.use("*", toHonoMiddleware(router));
    app.get("/health", (c) => c.json({ status: "ok" }));

    const response = await app.fetch(new Request("http://localhost/health"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("does not fall through when a matched operation returns 404", async () => {
    const router = mockRouter(
      async () => new Response("unused"),
      async () => Response.json({ source: "typespex" }, { status: 404 }),
    );
    const app = new Hono();
    app.use("*", toHonoMiddleware(router));
    app.get("/pets/:id", (c) => c.json({ source: "hono" }));

    const response = await app.fetch(new Request("http://localhost/pets/missing"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ source: "typespex" });
  });

  test("delegates unhandled router errors to Hono", async () => {
    const failure = new Error("boom");
    let observed: unknown;
    const router = mockRouter(
      async () => new Response("unused"),
      async () => {
        throw failure;
      },
    );
    const app = new Hono();
    app.use("*", toHonoMiddleware(router));
    app.onError((error, c) => {
      observed = error;
      return c.text("hono middleware error boundary", 598);
    });

    const response = await app.fetch(new Request("http://localhost/pets"));

    expect(response.status).toBe(598);
    expect(await response.text()).toBe("hono middleware error boundary");
    expect(observed).toBe(failure);
  });
});
