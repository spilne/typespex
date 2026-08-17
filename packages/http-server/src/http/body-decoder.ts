// Request-body selection, bounded parsing, and validation boundaries.
import { Either, isLeft, type Either as EitherT } from "../core/either.js";
import {
  enforceRequestBodyLimit,
  inheritRequestBodyLimit,
  releaseRequestBodyLimit,
  type RequestBodyLimit,
  RequestBodyTooLargeError,
} from "./body-limit.js";
import { createFile } from "./file.js";
import { parseJsonText } from "./json-value.js";
import { isContentTypeAccepted, parseMediaType } from "./media-type.js";
import { parseMultipartBody } from "./multipart-decoder.js";
import { MultipartSyntaxError } from "./multipart.js";
import { appendBodyField } from "./object-properties.js";
import { Decoder, toValidationResult } from "./value-decoder.js";
import { UnsupportedMediaTypeError, ValidationError } from "./validation.js";
import { parseXmlDocument } from "./xml-parser.js";

/**
 * Optional shared body decode options.
 * - `contentTypes`: when non-empty, the request `Content-Type` is validated;
 *   requests whose header does not match any entry are rejected with a
 *   415 `UnsupportedMediaTypeError` before body parsing.
 * - `root`: path prefix used in validation issue paths (default `"$body"`).
 * - `optional`: when true, a request with no body succeeds with `undefined`
 *   before Content-Type validation (default `false`).
 * - `allowMissingContentType`: when true, an absent Content-Type is accepted
 *   while any present value is still checked against `contentTypes`.
 * - `maxRequestBodyBytes`: maximum streamed body bytes. `undefined` uses the
 *   finite runtime default (or inherits an enclosing router limit); a
 *   non-negative safe integer overrides it; `false` disables decoder-level
 *   enforcement but cannot weaken an enclosing router policy.
 * - `fileNameProperty` and `fileBodyProperty`: generated merge metadata used
 *   to mirror a relocated path, query, or header filename into `File.name`.
 */
export interface BodyDecodeOptions {
  readonly contentTypes?: readonly string[];
  readonly root?: string;
  readonly optional?: boolean;
  readonly allowMissingContentType?: boolean;
  readonly maxRequestBodyBytes?: RequestBodyLimit;
  readonly fileNameProperty?: string;
  readonly fileBodyProperty?: string;
}

/** Options for lazily decoding a newline-delimited JSON request body. */
export interface JsonlBodyDecodeOptions {
  readonly contentTypes?: readonly string[];
  readonly root?: string;
  readonly allowMissingContentType?: boolean;
  readonly maxRequestBodyBytes?: RequestBodyLimit;
}

export type BodyDecodeError =
  | ValidationError
  | UnsupportedMediaTypeError
  | RequestBodyTooLargeError;

export type BodyMediaKind = "json" | "xml" | "form" | "multipart" | "file" | "text" | "binary";

/** Decoders generated for the wire representations accepted by one operation. */
export type BodyDecoderMap<A> = Readonly<Partial<Record<BodyMediaKind, Decoder<A>>>>;

/**
 * Parses and validates a request body according to its received Content-Type.
 * The decoder map keeps JSON validation strict while allowing textual HTTP
 * representations (forms, multipart fields, and text bodies) to coerce scalars.
 */
export function decodeBody<A>(
  request: Request,
  decoders: BodyDecoderMap<A>,
  options: BodyDecodeOptions & { readonly optional: true },
): Promise<EitherT<BodyDecodeError, A | undefined>>;
export function decodeBody<A>(
  request: Request,
  decoders: BodyDecoderMap<A>,
  options?: BodyDecodeOptions & { readonly optional?: false },
): Promise<EitherT<BodyDecodeError, A>>;
export function decodeBody<A>(
  request: Request,
  decoders: BodyDecoderMap<A>,
  options?: BodyDecodeOptions,
): Promise<EitherT<BodyDecodeError, A | undefined>>;
export async function decodeBody<A>(
  request: Request,
  decoders: BodyDecoderMap<A>,
  options: BodyDecodeOptions = {},
): Promise<EitherT<BodyDecodeError, A | undefined>> {
  const limitedRequest = requestForBodyDecoding(request, options.maxRequestBodyBytes);
  if (isLeft(limitedRequest)) return limitedRequest;
  request = limitedRequest.right;

  const root = options.root ?? "$body";
  const initialKind = selectBodyMediaKind(decoders, request.headers.get("content-type"));
  if (initialKind === "file") {
    if (options.optional && request.body === null) return Either.right(undefined);

    const contentTypeError = checkContentType(
      request,
      options.contentTypes,
      options.allowMissingContentType,
    );
    if (contentTypeError) return Either.left(contentTypeError);

    if (request.body === null) {
      return Either.left(
        new ValidationError([{ path: root, message: "Required body is missing." }]),
      );
    }
  }

  let bodyRequest = request;
  let abandonProbedBody: (() => void) | undefined;
  if (options.optional && initialKind !== "file") {
    try {
      const presentBody = await requestWithPresentBody(request);
      if (!presentBody) return Either.right(undefined);
      bodyRequest = presentBody.request;
      abandonProbedBody = presentBody.abandon;
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) return Either.left(error);
      const parser =
        BODY_PARSERS[selectBodyMediaKind(decoders, request.headers.get("content-type"))];
      return Either.left(new ValidationError([{ path: root, message: parser.failureMessage }]));
    }
  }

  const ctError =
    initialKind === "file"
      ? undefined
      : checkContentType(bodyRequest, options.contentTypes, options.allowMissingContentType);
  if (ctError) {
    abandonProbedBody?.();
    return Either.left(ctError);
  }

  const kind = selectBodyMediaKind(decoders, bodyRequest.headers.get("content-type"));
  const decoder = decoders[kind];
  if (!decoder) {
    abandonProbedBody?.();
    return Either.left(
      new UnsupportedMediaTypeError(
        bodyRequest.headers.get("content-type") ?? undefined,
        supportedMediaTypes(decoders),
      ),
    );
  }

  const parser = BODY_PARSERS[kind];
  try {
    return await decodeParsedBody(
      bodyRequest,
      decoder,
      { ...options, root },
      parser.parse,
      parser.failureMessage,
      true,
    );
  } finally {
    abandonProbedBody?.();
  }
}

interface PresentBodyRequest {
  readonly request: Request;
  /** Releases the probe's reader without canceling the underlying request. */
  readonly abandon: () => void;
}

/**
 * Distinguishes an empty streaming body from a present body without buffering
 * the payload. The first non-empty chunk is replayed into a replacement
 * Request so normal parsing can continue from the same stream.
 */
async function requestWithPresentBody(request: Request): Promise<PresentBodyRequest | undefined> {
  if (request.body === null) return undefined;

  const reader = request.body.getReader();
  let firstChunk: Uint8Array | undefined;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        reader.releaseLock();
        return undefined;
      }
      if (next.value.byteLength > 0) {
        firstChunk = next.value;
        break;
      }
    }
  } catch (error) {
    reader.releaseLock();
    throw error;
  }

  let released = false;
  let reading = false;
  let abandoned = false;
  let replayController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const release = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  const releaseAbandonedProbe = () => {
    release();
    releaseRequestBodyLimit(request);
  };
  const replayBody = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        replayController = controller;
      },
      async pull(controller) {
        if (abandoned) {
          if (!reading) releaseAbandonedProbe();
          return;
        }
        if (firstChunk) {
          const chunk = firstChunk;
          firstChunk = undefined;
          controller.enqueue(chunk);
          return;
        }

        try {
          reading = true;
          const next = await reader.read();
          reading = false;
          if (abandoned) {
            releaseAbandonedProbe();
            return;
          }
          if (next.done) {
            release();
            controller.close();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          reading = false;
          release();
          if (!abandoned) controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          release();
        }
      },
    },
    {
      // Only replay when the selected parser starts consuming the body.
      highWaterMark: 0,
    },
  );

  const replayRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: replayBody,
    signal: request.signal,
    // @ts-expect-error duplex is required for streaming bodies in Node.
    duplex: "half",
  });
  inheritRequestBodyLimit(request, replayRequest);

  return {
    request: replayRequest,
    abandon() {
      if (abandoned) return;
      abandoned = true;
      firstChunk = undefined;
      try {
        replayController?.close();
      } catch {
        // The parser may already have closed or errored the replay stream.
      }
      if (!reading) {
        releaseAbandonedProbe();
      }
    },
  };
}

/** Parses and validates the request JSON body. */
export function decodeJsonBody<A>(
  request: Request,
  decoder: Decoder<A>,
  options: BodyDecodeOptions & { readonly optional: true },
): Promise<EitherT<BodyDecodeError, A | undefined>>;
export function decodeJsonBody<A>(
  request: Request,
  decoder: Decoder<A>,
  options?: BodyDecodeOptions & { readonly optional?: false },
): Promise<EitherT<BodyDecodeError, A>>;
export function decodeJsonBody<A>(
  request: Request,
  decoder: Decoder<A>,
  options?: BodyDecodeOptions,
): Promise<EitherT<BodyDecodeError, A | undefined>>;
export async function decodeJsonBody<A>(
  request: Request,
  decoder: Decoder<A>,
  options: BodyDecodeOptions = {},
): Promise<EitherT<BodyDecodeError, A | undefined>> {
  const limitedRequest = requestForBodyDecoding(request, options.maxRequestBodyBytes);
  if (isLeft(limitedRequest)) return limitedRequest;
  request = limitedRequest.right;

  const root = options.root ?? "$body";
  let bodyRequest = request;
  let abandonProbedBody: (() => void) | undefined;
  if (options.optional) {
    try {
      const presentBody = await requestWithPresentBody(request);
      if (!presentBody) return Either.right(undefined);
      bodyRequest = presentBody.request;
      abandonProbedBody = presentBody.abandon;
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) return Either.left(error);
      return Either.left(
        new ValidationError([{ path: root, message: "Body must contain valid JSON." }]),
      );
    }
  }

  try {
    return await decodeParsedBody(
      bodyRequest,
      decoder,
      { ...options, root },
      parseJsonBody,
      "Body must contain valid JSON.",
    );
  } finally {
    abandonProbedBody?.();
  }
}

/**
 * Validates a JSONL request boundary and returns a single-use, lazy item stream.
 *
 * Content-Type, a known oversized Content-Length, and a missing body are
 * reported before the handler runs. UTF-8, JSON syntax, item validation, and
 * streamed size failures surface while the handler consumes the iterable.
 * Consumers must finish or close the iterable before the request handler
 * returns.
 */
export function decodeJsonlBody<A>(
  request: Request,
  decoder: Decoder<A>,
  options: JsonlBodyDecodeOptions = {},
): EitherT<BodyDecodeError, AsyncIterable<A>> {
  const limitedRequest = requestForBodyDecoding(request, options.maxRequestBodyBytes);
  if (isLeft(limitedRequest)) return limitedRequest;
  request = limitedRequest.right;

  const root = options.root ?? "$body";
  const contentTypeError = checkContentType(
    request,
    options.contentTypes ?? ["application/jsonl"],
    options.allowMissingContentType,
  );
  if (contentTypeError) return Either.left(contentTypeError);

  if (request.body === null) {
    return Either.left(new ValidationError([{ path: root, message: "Required body is missing." }]));
  }

  return Either.right(decodeJsonlItems(request, decoder, root));
}

async function* decodeJsonlItems<A>(
  request: Request,
  decoder: Decoder<A>,
  root: string,
): AsyncGenerator<A> {
  const reader = request.body!.getReader();
  const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const lines: JsonlLineState = { fragments: [] };
  let index = 0;

  try {
    for (;;) {
      const next = await readJsonlChunk(reader, root, index);
      if (next.done) break;

      const text = decodeJsonlText(textDecoder, next.value, true, root, index);
      for (const line of appendJsonlText(lines, text)) {
        const item = decodeJsonlItem(decoder, line, root, index);
        index += 1;
        yield item;
      }
    }

    const remainingText = decodeJsonlText(textDecoder, undefined, false, root, index);
    for (const line of appendJsonlText(lines, remainingText)) {
      const item = decodeJsonlItem(decoder, line, root, index);
      index += 1;
      yield item;
    }

    const finalLine = finishJsonlText(lines);
    if (finalLine !== undefined) {
      yield decodeJsonlItem(decoder, finalLine, root, index);
    }
  } finally {
    try {
      reader.releaseLock();
    } finally {
      releaseRequestBodyLimit(request);
    }
  }
}

interface JsonlLineState {
  readonly fragments: string[];
}

function* appendJsonlText(state: JsonlLineState, text: string): Generator<string> {
  let start = 0;
  for (;;) {
    const newline = text.indexOf("\n", start);
    if (newline < 0) break;

    const fragment = text.slice(start, newline);
    let line = fragment;
    if (state.fragments.length > 0) {
      state.fragments.push(fragment);
      line = state.fragments.join("");
      state.fragments.length = 0;
    }
    yield line.endsWith("\r") ? line.slice(0, -1) : line;
    start = newline + 1;
  }

  if (start < text.length) state.fragments.push(text.slice(start));
}

function finishJsonlText(state: JsonlLineState): string | undefined {
  if (state.fragments.length === 0) return undefined;
  const line = state.fragments.join("");
  state.fragments.length = 0;
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

async function readJsonlChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  root: string,
  index: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  try {
    return await reader.read();
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error;
    throw jsonlValidationError(root, index, "JSONL body could not be read.");
  }
}

function decodeJsonlText(
  decoder: TextDecoder,
  chunk: Uint8Array | undefined,
  stream: boolean,
  root: string,
  index: number,
): string {
  try {
    return chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream });
  } catch {
    throw jsonlValidationError(root, index, "JSONL body must contain valid UTF-8.");
  }
}

function decodeJsonlItem<A>(decoder: Decoder<A>, line: string, root: string, index: number): A {
  const path = `${root}[${index}]`;
  let value: unknown;
  try {
    value = parseJsonText(line);
  } catch {
    throw new ValidationError([{ path, message: "JSONL item must contain one valid JSON value." }]);
  }

  const decoded = toValidationResult(decoder.decode(value), path);
  if (isLeft(decoded)) throw decoded.left;
  return decoded.right;
}

function jsonlValidationError(root: string, index: number, message: string): ValidationError {
  return new ValidationError([{ path: `${root}[${index}]`, message }]);
}

/** Parses and validates a URL-encoded form body. */
export function decodeFormBody<A>(
  request: Request,
  decoder: Decoder<A>,
  options: BodyDecodeOptions = {},
): Promise<EitherT<BodyDecodeError, A>> {
  return decodeParsedBody(
    request,
    decoder,
    options,
    parseFormBody,
    "Body must contain valid form data.",
  );
}

/** Parses and validates a MIME multipart body. */
export function decodeMultipartBody<A>(
  request: Request,
  decoder: Decoder<A>,
  options: BodyDecodeOptions = {},
): Promise<EitherT<BodyDecodeError, A>> {
  return decodeParsedBody(
    request,
    decoder,
    options,
    parseMultipartBody,
    "Body must contain valid multipart MIME data.",
  );
}

async function decodeParsedBody<A>(
  request: Request,
  decoder: Decoder<A>,
  options: BodyDecodeOptions,
  parse: (request: Request, options: BodyDecodeOptions) => Promise<unknown>,
  parseFailureMessage: string,
  contentTypeChecked = false,
): Promise<EitherT<BodyDecodeError, A>> {
  const limitedRequest = requestForBodyDecoding(request, options.maxRequestBodyBytes);
  if (isLeft(limitedRequest)) return limitedRequest;
  request = limitedRequest.right;

  const root = options.root ?? "$body";
  if (!contentTypeChecked) {
    const ctError = checkContentType(
      request,
      options.contentTypes,
      options.allowMissingContentType,
    );
    if (ctError) return Either.left(ctError);
  }

  let value: unknown;
  try {
    value = await parse(request, options);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return Either.left(error);
    return Either.left(
      new ValidationError([
        {
          path: root,
          message: error instanceof MultipartSyntaxError ? error.message : parseFailureMessage,
        },
      ]),
    );
  }
  return toValidationResult(decoder.decode(value), root);
}

function requestForBodyDecoding(
  request: Request,
  maximum: RequestBodyLimit | undefined,
): EitherT<RequestBodyTooLargeError, Request> {
  try {
    return Either.right(enforceRequestBodyLimit(request, maximum));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return Either.left(error);
    throw error;
  }
}

async function parseJsonBody(request: Request): Promise<unknown> {
  return parseJsonText(await request.text());
}

function parseTextBody(request: Request): Promise<string> {
  return request.text();
}

async function parseXmlBody(request: Request): Promise<unknown> {
  return parseXmlDocument(await request.text());
}

async function parseBinaryBody(request: Request): Promise<Uint8Array> {
  return new Uint8Array(await request.arrayBuffer());
}

async function parseFormBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  return collectBodyFields(new URLSearchParams(text));
}

async function parseFileBody(request: Request): Promise<File> {
  const contentType = parseMediaType(request.headers.get("content-type")) ?? "";
  return createFile(new Uint8Array(await request.arrayBuffer()), "", contentType);
}

const BODY_PARSERS: Readonly<
  Record<
    BodyMediaKind,
    {
      readonly parse: (request: Request, options: BodyDecodeOptions) => Promise<unknown>;
      readonly failureMessage: string;
    }
  >
> = {
  json: { parse: parseJsonBody, failureMessage: "Body must contain valid JSON." },
  xml: { parse: parseXmlBody, failureMessage: "Body must contain valid XML." },
  form: { parse: parseFormBody, failureMessage: "Body must contain valid form data." },
  multipart: {
    parse: parseMultipartBody,
    failureMessage: "Body must contain valid multipart MIME data.",
  },
  file: { parse: parseFileBody, failureMessage: "Body must contain valid file content." },
  text: { parse: parseTextBody, failureMessage: "Body must contain valid text." },
  binary: { parse: parseBinaryBody, failureMessage: "Body must contain valid binary data." },
};

function bodyMediaKind(contentType: string | null): BodyMediaKind {
  const mediaType = parseMediaType(contentType);
  if (!mediaType || mediaType === "application/json" || mediaType.endsWith("+json")) {
    return "json";
  }
  const subtype = mediaType.slice(mediaType.indexOf("/") + 1);
  if (
    mediaType === "application/xml" ||
    mediaType === "text/xml" ||
    (subtype.length > "+xml".length && subtype.endsWith("+xml"))
  ) {
    return "xml";
  }
  if (mediaType === "application/x-www-form-urlencoded") return "form";
  if (mediaType.startsWith("multipart/")) return "multipart";
  if (mediaType.startsWith("text/")) return "text";
  return "binary";
}

function selectBodyMediaKind<A>(
  decoders: BodyDecoderMap<A>,
  contentType: string | null,
): BodyMediaKind {
  if (decoders.file) return "file";
  const kind = bodyMediaKind(contentType);
  if (decoders[kind]) return kind;

  const mediaType = parseMediaType(contentType);
  if (kind === "xml" && mediaType?.startsWith("text/") && decoders.text) return "text";
  if (
    (kind === "json" || kind === "xml") &&
    mediaType !== undefined &&
    !mediaType.startsWith("application/") &&
    !mediaType.startsWith("text/") &&
    !mediaType.startsWith("multipart/") &&
    decoders.binary
  ) {
    return "binary";
  }
  return kind;
}

function supportedMediaTypes<A>(decoders: BodyDecoderMap<A>): string[] {
  const supported: string[] = [];
  if (decoders.json) supported.push("application/json");
  if (decoders.xml) supported.push("application/xml", "text/xml");
  if (decoders.form) supported.push("application/x-www-form-urlencoded");
  if (decoders.multipart) supported.push("multipart/form-data");
  if (decoders.file) supported.push("*/*");
  if (decoders.text) supported.push("text/*");
  if (decoders.binary) supported.push("application/octet-stream");
  return supported;
}

function collectBodyFields(entries: Iterable<readonly [string, unknown]>): Record<string, unknown> {
  const value: Record<string, unknown> = Object.create(null);
  for (const [key, val] of entries) {
    appendBodyField(value, key, val);
  }
  return value;
}

function checkContentType(
  request: Request,
  declared: readonly string[] | undefined,
  allowMissing = false,
): UnsupportedMediaTypeError | undefined {
  if (!declared || declared.length === 0) return undefined;
  const received = request.headers.get("content-type");
  if (allowMissing && received === null) return undefined;
  if (isContentTypeAccepted(received, declared)) return undefined;
  return new UnsupportedMediaTypeError(received ?? undefined, declared);
}

/** Parses and validates the request JSON body, throws on failure. */
export function decodeJsonBodyOrThrow<A>(
  request: Request,
  decoder: Decoder<A>,
  options: BodyDecodeOptions & { readonly optional: true },
): Promise<A | undefined>;
export function decodeJsonBodyOrThrow<A>(
  request: Request,
  decoder: Decoder<A>,
  options?: BodyDecodeOptions & { readonly optional?: false },
): Promise<A>;
export function decodeJsonBodyOrThrow<A>(
  request: Request,
  decoder: Decoder<A>,
  options?: BodyDecodeOptions,
): Promise<A | undefined>;
export async function decodeJsonBodyOrThrow<A>(
  request: Request,
  decoder: Decoder<A>,
  options: BodyDecodeOptions = {},
): Promise<A | undefined> {
  return Either.getOrElseThrow(await decodeJsonBody(request, decoder, options));
}
