import type { RequestHandler } from "express";
import { toNodeHandler, type NodeHandlerOptions } from "@typespex/adapter-node";
import type { HttpRouter } from "@typespex/http-server";

export type ExpressRequestHandler = RequestHandler;

export interface ExpressHandlerOptions extends Omit<NodeHandlerOptions, "errorMode" | "logger"> {}

/**
 * Creates a terminal Express handler from a Fetch router.
 *
 * The generated router owns the mounted path, including its not-found
 * response. Errors escaping the router boundary are delegated to Express error
 * middleware. Register the handler before middleware that consumes the Node
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
  const nodeHandler = toNodeHandler(router, { ...options, errorMode: "throw" });
  return async (request, response, next) => {
    try {
      await nodeHandler(request, response);
    } catch (error) {
      next(error);
    }
  };
}
