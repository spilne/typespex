import type { RequestHandler } from "express";
import type { HttpRouter } from "@typespex/runtime/server";
import { toNodeHandler, type NodeHandlerOptions } from "@typespex/shim-node";

export interface ExpressHandlerOptions extends NodeHandlerOptions {}

/**
 * Creates a terminal Express handler from an HttpRouter.
 *
 * The generated router owns the mounted path, including its not-found
 * response. Errors escaping the router boundary use the Node adapter's logged
 * 500 response. Register the handler before middleware that consumes the Node
 * request body stream.
 *
 * @example
 * const app = express();
 * app.use("/api", toExpressHandler(router));
 */
export function toExpressHandler(
  router: HttpRouter,
  options?: ExpressHandlerOptions,
): RequestHandler {
  const nodeHandler = toNodeHandler(router, options);
  return (request, response) => nodeHandler(request, response);
}
