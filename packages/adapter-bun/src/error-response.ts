import type { Logger } from "@typespex/http-server";

export function errorResponse(error: unknown, logger: Logger, request?: Request): Response {
  logger.error("Unhandled error in request handler", {
    error,
    ...(request ? { method: request.method, url: request.url } : {}),
  });
  return new Response("Internal Server Error", { status: 500 });
}
