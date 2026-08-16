import { Hono, type MiddlewareHandler } from "hono";
import type { ComposableHttpRouter, HttpRouter } from "@typespex/http-server";

/**
 * Creates Hono middleware that delegates matched requests to a composable Fetch router and
 * falls through to subsequent Hono handlers when no TypeSpec route matches.
 *
 * Register it before routes that should handle unmatched requests:
 *
 * @example
 * const app = new Hono();
 * app.use("*", toHonoMiddleware(router));
 * app.get("/health", (c) => c.text("ok"));
 */
export function toHonoMiddleware(router: ComposableHttpRouter): MiddlewareHandler {
  return async (c, next) => {
    const response = await router.tryHandle(c.req.raw);

    if (response === undefined) {
      await next();
      return;
    }

    return response;
  };
}

/**
 * Creates a Hono app from a Fetch router.
 *
 * @example
 * const app = toHonoApp(router);
 * export default app;
 */
export function toHonoApp(router: HttpRouter): Hono {
  const app = new Hono();

  app.all("*", (c) => router.handle(c.req.raw));

  return app;
}
