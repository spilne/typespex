import { consoleLogger, type HttpRouter, type Logger } from "@typespex/http-server";

export interface BunHandlerOptions {
  readonly logger?: Logger;
}

/**
 * Creates a Bun.serve-compatible handler from a Fetch router.
 *
 * @example
 * Bun.serve({ port: 3000, ...toBunHandler(router) });
 */
export function toBunHandler(
  router: HttpRouter,
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
