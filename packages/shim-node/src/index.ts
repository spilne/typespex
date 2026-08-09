import type { IncomingMessage, ServerResponse } from "node:http";
import { type HttpRouter, type Logger, consoleLogger } from "@typespex/runtime/server";

export interface NodeHandlerOptions {
  readonly logger?: Logger;
  /** Trust the first X-Forwarded-Proto value when running behind a trusted proxy. */
  readonly trustProxy?: boolean;
}

/**
 * Creates a Node.js http.createServer-compatible handler from an HttpRouter.
 *
 * @example
 * import http from "node:http";
 * http.createServer(toNodeHandler(router)).listen(3000);
 */
export function toNodeHandler(
  router: HttpRouter,
  options?: NodeHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const logger = options?.logger ?? consoleLogger;
  return async (req, res) => {
    let releaseRequestBody: (() => void) | undefined;
    const lifecycle = monitorClientConnection(req, res);
    try {
      const converted = incomingMessageToRequest(req, lifecycle.abortController, options);
      const request = converted.request;
      releaseRequestBody = converted.releaseBody;
      const response = await router.handle(request);
      await writeResponse(response, res, lifecycle.disconnectSignal);
    } catch (error) {
      if (lifecycle.disconnectSignal.aborted) {
        if (!res.destroyed) res.destroy(toError(error));
        return;
      }
      logger.error("Unhandled error in request handler", {
        error,
        method: req.method,
        url: req.url,
      });
      if (res.headersSent || res.writableEnded || res.destroyed) {
        if (!res.destroyed) res.destroy(toError(error));
        return;
      }
      for (const name of res.getHeaderNames()) res.removeHeader(name);
      res.statusCode = 500;
      res.end("Internal Server Error");
    } finally {
      releaseRequestBody?.();
      lifecycle.cleanup();
    }
  };
}

interface ClientConnectionLifecycle {
  readonly abortController: AbortController;
  readonly disconnectSignal: AbortSignal;
  readonly cleanup: () => void;
}

function monitorClientConnection(
  req: IncomingMessage,
  res: ServerResponse,
): ClientConnectionLifecycle {
  const abortController = new AbortController();
  const disconnectController = new AbortController();
  const sockets = [req.socket, res.socket].filter(
    (socket, index, values): socket is NonNullable<typeof socket> =>
      socket != null && typeof socket.once === "function" && values.indexOf(socket) === index,
  );
  let cleaned = false;

  const abortRequest = (reason: Error) => {
    if (!abortController.signal.aborted) abortController.abort(reason);
  };
  const disconnect = (reason: Error) => {
    abortRequest(reason);
    if (!disconnectController.signal.aborted) disconnectController.abort(reason);
  };
  const onRequestAborted = () => {
    disconnect(new Error("Client aborted the request."));
  };
  const onRequestError = (error: Error) => {
    abortRequest(error);
  };
  const onResponseClose = () => {
    if (!res.writableEnded) {
      disconnect(new Error("Client connection closed before the response completed."));
    }
  };
  const onResponseError = (error: Error) => {
    if (!res.writableEnded) disconnect(error);
  };
  const onSocketClose = () => {
    if (!res.writableEnded) {
      disconnect(new Error("Client connection closed before the response completed."));
    }
  };
  const onSocketError = (error: Error) => {
    if (!res.writableEnded) disconnect(error);
  };

  req.once("aborted", onRequestAborted);
  req.once("error", onRequestError);
  res.once("close", onResponseClose);
  res.once("error", onResponseError);
  for (const socket of sockets) {
    socket.once("close", onSocketClose);
    socket.once("error", onSocketError);
  }

  return {
    abortController,
    disconnectSignal: disconnectController.signal,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      req.off("aborted", onRequestAborted);
      req.off("error", onRequestError);
      res.off("close", onResponseClose);
      res.off("error", onResponseError);
      for (const socket of sockets) {
        socket.off("close", onSocketClose);
        socket.off("error", onSocketError);
      }
    },
  };
}

interface ConvertedIncomingRequest {
  readonly request: Request;
  readonly releaseBody: () => void;
}

function incomingMessageToRequest(
  req: IncomingMessage,
  abortController: AbortController,
  options?: NodeHandlerOptions,
): ConvertedIncomingRequest {
  const forwarded = options?.trustProxy ? req.headers["x-forwarded-proto"] : undefined;
  const firstForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const forwardedProtocol =
    typeof firstForwarded === "string"
      ? firstForwarded.split(",", 1)[0].trim().toLowerCase()
      : undefined;
  const socket = req.socket;
  const encrypted = socket != null && "encrypted" in socket && socket.encrypted === true;
  const protocol =
    forwardedProtocol === "http" || forwardedProtocol === "https"
      ? forwardedProtocol
      : encrypted
        ? "https"
        : "http";
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
  const hasBody = hasIncomingBody(req, method);

  const bodyBridge = hasBody ? incomingBodyStream(req, abortController) : undefined;

  return {
    request: new Request(url.toString(), {
      method,
      headers,
      body: bodyBridge?.stream,
      signal: abortController.signal,
      // @ts-expect-error duplex is required for streaming bodies in Node
      duplex: hasBody ? "half" : undefined,
    }),
    releaseBody: bodyBridge?.drain ?? (() => {}),
  };
}

function hasIncomingBody(req: IncomingMessage, method: string): boolean {
  if (method === "GET" || method === "HEAD") return false;
  if (req.headers["transfer-encoding"] !== undefined) return true;

  const header = req.headers["content-length"];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return false;
  const length = Number(value);
  return !Number.isFinite(length) || length > 0;
}

function incomingBodyStream(
  req: IncomingMessage,
  abortController: AbortController,
): { readonly stream: ReadableStream<Uint8Array>; readonly drain: () => void } {
  let closed = false;
  let cleanup = () => {};
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

  // A data listener makes a Node Readable flow unless it has already been paused.
  req.pause();
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        streamController = controller;
        cleanup = () => {
          req.off("data", onData);
          req.off("end", onEnd);
          req.off("aborted", onAborted);
          req.off("error", onError);
        };
        const finish = (action: () => void) => {
          if (closed) return;
          closed = true;
          cleanup();
          action();
        };
        const onData = (chunk: Buffer) => {
          controller.enqueue(chunk);
          if ((controller.desiredSize ?? 1) <= 0) req.pause();
        };
        const onEnd = () => finish(() => controller.close());
        const onAborted = () => {
          const error = new Error("Client aborted the request body.");
          abortController.abort(error);
          finish(() => controller.error(error));
        };
        const onError = (error: Error) => {
          abortController.abort(error);
          finish(() => controller.error(error));
        };

        req.on("data", onData);
        req.once("end", onEnd);
        req.once("aborted", onAborted);
        req.once("error", onError);
      },
      pull() {
        req.resume();
      },
      cancel() {
        if (closed) return;
        closed = true;
        cleanup();
        req.destroy();
      },
    },
    {
      // Pull only when application code asks for data; do not prefill a Web stream queue.
      highWaterMark: 0,
    },
  );

  return {
    stream,
    drain() {
      if (closed) return;
      closed = true;
      cleanup();
      try {
        streamController?.close();
      } catch {
        // The stream may already be canceled or errored by user code.
      }
      const ignoreDrainError = () => {};
      req.on("error", ignoreDrainError);
      req.once("close", () => req.off("error", ignoreDrainError));
      req.resume();
    },
  };
}

async function writeResponse(
  response: Response,
  res: ServerResponse,
  disconnectSignal: AbortSignal,
): Promise<void> {
  if (disconnectSignal.aborted) {
    await response.body?.cancel(disconnectSignal.reason).catch(() => undefined);
    throw abortError(disconnectSignal);
  }

  res.statusCode = response.status;

  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    res.setHeader(key, value);
  });
  const setCookies = getSetCookieHeaders(response.headers);
  if (setCookies.length > 0) {
    res.setHeader("set-cookie", setCookies);
  }

  if (response.body) {
    const reader = response.body.getReader();
    let cancellation: Promise<void> | undefined;
    let rejectDisconnect: ((reason: Error) => void) | undefined;
    const disconnected = new Promise<never>((_resolve, reject) => {
      rejectDisconnect = reject;
    });
    const cancelReader = (reason: unknown): Promise<void> => {
      cancellation ??= reader.cancel(reason).catch(() => undefined);
      return cancellation;
    };
    const onAbort = () => {
      const error = abortError(disconnectSignal);
      void cancelReader(disconnectSignal.reason);
      rejectDisconnect?.(error);
    };

    disconnectSignal.addEventListener("abort", onAbort, { once: true });
    try {
      if (disconnectSignal.aborted) onAbort();
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), disconnected]);
        if (done) break;
        if (!res.write(value)) {
          await Promise.race([waitForDrain(res), disconnected]);
        }
      }
    } catch (error) {
      await cancelReader(error);
      throw error;
    } finally {
      disconnectSignal.removeEventListener("abort", onAbort);
      reader.releaseLock();
    }
  }

  if (disconnectSignal.aborted) throw abortError(disconnectSignal);
  res.end();
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Client connection closed before the response completed.");
}

function getSetCookieHeaders(headers: Headers): readonly string[] {
  const getSetCookie = headers.getSetCookie;
  if (typeof getSetCookie === "function") return getSetCookie.call(headers);
  const combined = headers.get("set-cookie");
  return combined === null ? [] : [combined];
}

function waitForDrain(res: ServerResponse): Promise<void> {
  if (res.destroyed) {
    return Promise.reject(new Error("Client connection closed while streaming response."));
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Client connection closed while streaming response."));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
  });
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
