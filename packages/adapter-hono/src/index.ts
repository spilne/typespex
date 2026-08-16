import { Hono, type Context, type MiddlewareHandler } from "hono";

export interface FetchRouter {
  handle(request: Request): Promise<Response>;
}

export interface ComposableFetchRouter extends FetchRouter {
  tryHandle(request: Request): Promise<Response | undefined>;
}

export interface AdapterLogContext {
  readonly [key: string]: unknown;
}

export interface AdapterLogger {
  error(message: string, context?: AdapterLogContext): void;
}

const consoleLogger: AdapterLogger = {
  error(message, context) {
    if (context) console.error(message, context);
    else console.error(message);
  },
};

export interface HonoAppOptions {
  readonly logger?: AdapterLogger;
}

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
export function toHonoMiddleware(
  router: ComposableFetchRouter,
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
 * Creates a Hono app from a Fetch router.
 *
 * @example
 * const app = toHonoApp(router);
 * export default app;
 */
export function toHonoApp(router: FetchRouter, options?: HonoAppOptions): Hono {
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
