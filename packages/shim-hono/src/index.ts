import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  type ComposableHttpRouter,
  type HttpRouter,
  type Logger,
  consoleLogger,
} from "@typespex/runtime/server";

export interface HonoAppOptions {
  readonly logger?: Logger;
}

/**
 * Creates Hono middleware that delegates matched requests to an HttpRouter and
 * falls through to subsequent Hono handlers when no TypeSpec route matches.
 *
 * Register it before routes that should handle unmatched requests:
 *
 * @example
 * const app = new Hono();
 * app.use("*", toHonoMiddleware(router));
 * app.get("/health", (c) => c.text("ok"));
 */
export function toHonoMiddleware(
  router: ComposableHttpRouter,
  options?: HonoAppOptions,
): MiddlewareHandler {
  const logger = options?.logger ?? consoleLogger;

  return async (c, next) => {
    let response: Response | undefined;
    try {
      response = await router.tryHandle(c.req.raw);
    } catch (error) {
      logger.error("Unhandled error in request handler", {
        error,
        method: c.req.method,
        url: c.req.url,
      });
      return c.text("Internal Server Error", 500);
    }

    if (response === undefined) {
      await next();
      return;
    }

    return response;
  };
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
