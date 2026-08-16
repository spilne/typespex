export interface FetchRouter {
  handle(request: Request): Promise<Response>;
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

export interface BunHandlerOptions {
  readonly logger?: AdapterLogger;
}

/**
 * Creates a Bun.serve-compatible handler from a Fetch router.
 *
 * @example
 * Bun.serve({ port: 3000, ...toBunHandler(router) });
 */
export function toBunHandler(
  router: FetchRouter,
  options?: BunHandlerOptions,
): {
  fetch: (request: Request) => Promise<Response>;
} {
  const logger = options?.logger ?? consoleLogger;
  return {
    async fetch(request: Request): Promise<Response> {
      try {
        return await router.handle(request);
      } catch (error) {
        logger.error("Unhandled error in request handler", {
          error,
          method: request.method,
          url: request.url,
        });
        return new Response("Internal Server Error", { status: 500 });
      }
    },
  };
}
