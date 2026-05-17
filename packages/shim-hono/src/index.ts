import { Hono, type Context } from "hono";
import { type HttpRouter, type Logger, consoleLogger } from "@typespex/runtime/server";

export interface HonoAppOptions {
  readonly logger?: Logger;
}

/**
 * Creates a Hono app from an HttpRouter.
 *
 * @example
 * const app = toHonoApp(router);
 * export default app;
 */
export function toHonoApp(router: HttpRouter, options?: HonoAppOptions): Hono {
  const logger = options?.logger ?? consoleLogger;
  const app = new Hono();

  app.all("*", async (c: Context) => {
    try {
      return await router.handle(c.req.raw);
    } catch (error) {
      logger.error("Unhandled error in request handler", {
        error,
        method: c.req.method,
        url: c.req.url,
      });
      return c.text("Internal Server Error", 500);
    }
  });

  return app;
}
