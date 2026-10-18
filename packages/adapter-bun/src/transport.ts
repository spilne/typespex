import type { HttpRequestTransportInfo } from "@typespex/http-server";

/** Only call for a request whose original HTTP framing is guaranteed by the caller. */
export function framedRequestBody(request: Request): HttpRequestTransportInfo | undefined {
  // Bun never exposes a GET or HEAD body, so the readable body is empty without
  // materializing the request headers.
  if (request.method === "GET" || request.method === "HEAD") {
    return { request, verifiedBodyLength: 0 };
  }
  const contentLength = request.headers.get("content-length");
  if (
    contentLength === null ||
    request.headers.has("transfer-encoding") ||
    !/^\d+$/.test(contentLength)
  )
    return undefined;
  const length = Number(contentLength);
  if (!Number.isSafeInteger(length) || length < 0) return undefined;
  return { request, verifiedBodyLength: length };
}
