import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpRouter } from "@typespex/runtime/server";

/**
 * Creates a Node.js http.createServer-compatible handler from an HttpRouter.
 * Converts IncomingMessage → Request, dispatches, then writes Response → ServerResponse.
 *
 * @example
 * import http from "node:http";
 * http.createServer(toNodeHandler(router)).listen(3000);
 */
export function toNodeHandler(
  router: HttpRouter,
): (req: IncomingMessage, res: ServerResponse) => void {
  return async (req, res) => {
    try {
      const request = incomingMessageToRequest(req);
      const response = await router.handle(request);
      await writeResponse(response, res);
    } catch (error) {
      console.error("[typespex] Unhandled error in request handler:", error);
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  };
}

function incomingMessageToRequest(req: IncomingMessage): Request {
  const forwarded = req.headers["x-forwarded-proto"];
  const protocol = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "http";
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `${protocol}://${host}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        headers.append(key, v);
      }
    } else {
      headers.set(key, value);
    }
  }

  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";

  const body = hasBody
    ? new ReadableStream<Uint8Array>({
        start(controller) {
          req.on("data", (chunk: Buffer) =>
            controller.enqueue(new Uint8Array(chunk)),
          );
          req.on("end", () => controller.close());
          req.on("error", (err) => controller.error(err));
        },
      })
    : undefined;

  return new Request(url.toString(), {
    method,
    headers,
    body,
    // @ts-expect-error duplex is required for streaming bodies in Node
    duplex: hasBody ? "half" : undefined,
  });
}

async function writeResponse(
  response: Response,
  res: ServerResponse,
): Promise<void> {
  res.statusCode = response.status;

  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }

  res.end();
}
