/**
 * Base class for HTTP errors that handlers or middleware can throw.
 * The router's onError handler catches these and converts them
 * to proper HTTP responses.
 */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly body?: unknown,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "HttpError";
  }

  toResponse(): Response {
    const responseHeaders = new Headers(this.headers);
    if (this.body != null) {
      responseHeaders.set("content-type", "application/json");
      return new Response(JSON.stringify(this.body), {
        status: this.statusCode,
        headers: responseHeaders,
      });
    }
    return new Response(this.message, {
      status: this.statusCode,
      headers: responseHeaders,
    });
  }
}
