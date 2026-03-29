import { describe, expect, test } from "bun:test";
import { toHonoApp } from "../src/index.js";
import type { HttpRouter } from "@typespex/runtime/server";

function mockRouter(handle: (request: Request) => Promise<Response>): HttpRouter {
  return { handle };
}

describe("toHonoApp", () => {
  test("delegates all requests to the router", async () => {
    const router = mockRouter(async (request) =>
      Response.json({ path: new URL(request.url).pathname }),
    );
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
    const router = mockRouter(async () =>
      Response.json({ error: "Not Found" }, { status: 404 }),
    );
    const app = toHonoApp(router);

    const response = await app.fetch(new Request("http://localhost/unknown"));
    expect(response.status).toBe(404);
  });

  test("returns 500 on unhandled router error", async () => {
    const router = mockRouter(async () => {
      throw new Error("boom");
    });
    const app = toHonoApp(router);

    const response = await app.fetch(new Request("http://localhost/test"));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
  });
});
