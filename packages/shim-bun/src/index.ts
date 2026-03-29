import type { HttpRouter } from "@typespex/runtime/server";

/**
 * Creates a Bun.serve-compatible handler from an HttpRouter.
 * Bun natively uses Web Standard Request/Response — direct passthrough.
 *
 * @example
 * Bun.serve({ port: 3000, ...toBunHandler(router) });
 */
export function toBunHandler(router: HttpRouter): {
  fetch: (request: Request) => Promise<Response>;
} {
  return {
    async fetch(request: Request): Promise<Response> {
      try {
        return await router.handle(request);
      } catch (error) {
        console.error("[typespex] Unhandled error in request handler:", error);
        return new Response("Internal Server Error", { status: 500 });
      }
    },
  };
}
