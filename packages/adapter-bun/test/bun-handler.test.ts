import { describe, expect, test } from "bun:test";
import { toBunHandler } from "../src/index.js";
import type { HttpRouter } from "@typespex/http-server";

function mockRouter(handle: (request: Request) => Promise<Response>): HttpRouter {
  return { handle, tryHandle: handle };
}

describe("toBunHandler", () => {
  test("passes request through and returns response", async () => {
    const router = mockRouter(async (request) =>
      Response.json({ url: request.url, method: request.method }),
    );
    const handler = toBunHandler(router);

    const response = await handler.fetch(new Request("http://localhost/test"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: "http://localhost/test",
      method: "GET",
    });
  });

  test("returns 404 from router for unmatched routes", async () => {
    const router = mockRouter(async () => Response.json({ error: "Not Found" }, { status: 404 }));
    const handler = toBunHandler(router);

    const response = await handler.fetch(new Request("http://localhost/unknown"));
    expect(response.status).toBe(404);
  });

  test("returns 500 on unhandled router error", async () => {
    const router = mockRouter(async () => {
      throw new Error("boom");
    });
    const handler = toBunHandler(router);

    const response = await handler.fetch(new Request("http://localhost/test"));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
  });
});
