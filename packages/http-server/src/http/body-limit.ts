import { HttpError } from "../errors.js";

/**
 * Default maximum request-body size: 10 MiB.
 *
 * This is large enough for typical API JSON, forms, and modest file payloads
 * while keeping every buffered decoder behind a finite allocation boundary.
 */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

/** A byte limit, or `false` to disable body-size enforcement explicitly. */
export type RequestBodyLimit = number | false;

/** Structured 413 response raised when a request body exceeds its byte limit. */
export class RequestBodyTooLargeError extends HttpError {
  constructor(
    public readonly maxBytes: number,
    public readonly declaredBytes?: string,
    public readonly receivedBytes?: number,
  ) {
    super(413, "Content Too Large", {
      error: "Content Too Large",
      maxBytes,
    });
    this.name = "RequestBodyTooLargeError";
  }
}

interface RequestBodyLimitState {
  maximum: RequestBodyLimit;
  received: number;
  readonly source: ReadableStream<Uint8Array> | null;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  reading: boolean;
  draining: boolean;
  drainRequested: boolean;
  error?: RequestBodyTooLargeError;
}

const requestBodyLimitStates = new WeakMap<Request, RequestBodyLimitState>();

/**
 * Resolves and validates a request-body limit.
 *
 * `undefined` selects {@link DEFAULT_MAX_REQUEST_BODY_BYTES}; `false` disables
 * enforcement. Numeric limits must be non-negative safe integers. A limit of
 * zero permits only an empty body.
 */
export function resolveRequestBodyLimit(limit?: RequestBodyLimit): RequestBodyLimit {
  if (limit === undefined) return DEFAULT_MAX_REQUEST_BODY_BYTES;
  if (limit === false) return false;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("Request body byte limits must be non-negative safe integers or false.");
  }
  return limit;
}

/**
 * Returns a request whose body is counted while it is consumed.
 *
 * Reapplying an unspecified limit to an already-limited request inherits the
 * existing policy. An explicit smaller limit tightens the existing counter
 * without wrapping or counting the stream again; an explicit larger limit or
 * `false` cannot weaken an enclosing router policy.
 */
export function enforceRequestBodyLimit(
  request: Request,
  configuredLimit?: RequestBodyLimit,
): Request {
  const existing = requestBodyLimitStates.get(request);
  if (existing) {
    if (configuredLimit === undefined || configuredLimit === false) return request;

    const requested = resolveRequestBodyLimit(configuredLimit);
    if (requested === false || (existing.maximum !== false && requested >= existing.maximum)) {
      return request;
    }
    if (existing.maximum === false) {
      return createLimitedRequest(request, requested);
    }

    existing.maximum = requested;
    const error =
      contentLengthError(request, requested) ??
      (existing.received > requested
        ? new RequestBodyTooLargeError(requested, undefined, existing.received)
        : undefined);
    if (error) {
      existing.error = error;
      beginSafeDrain(existing);
      throw error;
    }
    return request;
  }

  const maximum = resolveRequestBodyLimit(configuredLimit);
  if (maximum === false) {
    requestBodyLimitStates.set(request, {
      maximum,
      received: 0,
      source: request.body,
      reading: false,
      draining: false,
      drainRequested: false,
    });
    return request;
  }

  return createLimitedRequest(request, maximum);
}

/**
 * Carries counting state across an internal replay request without adding
 * another stream wrapper.
 *
 * @internal
 */
export function inheritRequestBodyLimit(source: Request, target: Request): void {
  const state = requestBodyLimitStates.get(source);
  if (state) requestBodyLimitStates.set(target, state);
}

/**
 * Releases a limit wrapper's upstream reader when an internal replay is
 * abandoned before parsing starts.
 *
 * @internal
 */
export function releaseRequestBodyLimit(request: Request): void {
  const state = requestBodyLimitStates.get(request);
  if (state && !state.reading && !state.draining) releaseReader(state);
}

function createLimitedRequest(request: Request, maximum: number): Request {
  const state: RequestBodyLimitState = {
    maximum,
    received: 0,
    source: request.body,
    reading: false,
    draining: false,
    drainRequested: false,
  };

  const earlyError = contentLengthError(request, maximum);
  if (earlyError) {
    state.error = earlyError;
    beginSafeDrain(state);
    throw earlyError;
  }
  if (request.body === null) {
    requestBodyLimitStates.set(request, state);
    return request;
  }

  const limitedBody = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (state.error) {
          controller.error(state.error);
          return;
        }

        try {
          const reader = (state.reader ??= state.source!.getReader());
          state.reading = true;
          const next = await reader.read();
          state.reading = false;

          if (state.error) {
            controller.error(state.error);
            beginSafeDrain(state);
            return;
          }
          if (next.done) {
            releaseReader(state);
            controller.close();
            return;
          }

          state.received += next.value.byteLength;
          const currentMaximum = state.maximum;
          if (currentMaximum !== false && state.received > currentMaximum) {
            const error = new RequestBodyTooLargeError(currentMaximum, undefined, state.received);
            state.error = error;
            controller.error(error);
            beginSafeDrain(state);
            return;
          }

          controller.enqueue(next.value);
        } catch (error) {
          state.reading = false;
          releaseReader(state);
          controller.error(error);
        }
      },
      async cancel(reason) {
        if (state.draining) return;
        const reader = state.reader;
        try {
          if (reader) await reader.cancel(reason);
          else await state.source?.cancel(reason);
        } finally {
          releaseReader(state);
        }
      },
    },
    {
      // Do not pull or lock the adapter-owned body until a decoder consumes it.
      highWaterMark: 0,
    },
  );

  const limitedRequest = new Request(request, {
    body: limitedBody,
    signal: request.signal,
    // @ts-expect-error duplex is required for streaming bodies in Node.
    duplex: "half",
  });
  requestBodyLimitStates.set(limitedRequest, state);
  return limitedRequest;
}

function contentLengthError(
  request: Request,
  maximum: number,
): RequestBodyTooLargeError | undefined {
  const value = request.headers.get("content-length");
  if (value === null || !/^\d+$/.test(value)) return undefined;

  const normalized = value.replace(/^0+(?=\d)/, "");
  const maximumText = String(maximum);
  if (
    normalized.length > maximumText.length ||
    (normalized.length === maximumText.length && normalized > maximumText)
  ) {
    return new RequestBodyTooLargeError(maximum, value);
  }
  return undefined;
}

/**
 * Discard the rest without canceling the adapter's transport stream. Adapters
 * can then write the 413 response while draining the unread request bytes.
 */
function beginSafeDrain(state: RequestBodyLimitState): void {
  state.drainRequested = true;
  if (state.reading || state.draining || state.source === null) return;
  state.draining = true;

  void (async () => {
    try {
      const reader = (state.reader ??= state.source!.getReader());
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
      }
    } catch {
      // A peer disconnect while discarding an oversized body needs no response.
    } finally {
      releaseReader(state);
      state.draining = false;
      state.drainRequested = false;
    }
  })();
}

function releaseReader(state: RequestBodyLimitState): void {
  const reader = state.reader;
  if (!reader) return;
  state.reader = undefined;
  try {
    reader.releaseLock();
  } catch {
    // Cancellation or a transport error may already have released the lock.
  }
  if (state.drainRequested && !state.draining) beginSafeDrain(state);
}
