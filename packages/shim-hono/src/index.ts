import { Hono, type Context } from "hono";
import type { HttpRouter } from "@typespex/runtime/server";

/**
 * Creates a Hono app from an HttpRouter.
 * Registers a catch-all handler that delegates to the runtime router.
 *
 * @example
 * const app = toHonoApp(router);
 * export default app;
 */
export function toHonoApp(router: HttpRouter): Hono {
  const app = new Hono();

  app.all("*", async (c: Context) => {
    try {
      return await router.handle(c.req.raw);
    } catch (error) {
      console.error("[typespex] Unhandled error in request handler:", error);
      return c.text("Internal Server Error", 500);
    }
  });

  return app;
}
