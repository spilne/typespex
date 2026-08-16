import { describe, expect, test } from "bun:test";
import {
  bindRoute,
  createHttpRouter,
  Decoders,
  decodeJsonlBody,
  decodeRequestInputAndJsonlBody,
  emptyHints,
  RequestBodyTooLargeError,
  RequestDecoders,
  type ServerOperation,
  UnsupportedMediaTypeError,
  ValidationError,
} from "../src/server.js";

interface StreamState {
  readonly request: Request;
  readonly pulls: () => number;
  readonly canceled: () => boolean;
}

function streamingRequest(
  chunks: readonly Uint8Array[],
  contentType = "application/jsonl",
): StreamState {
  const pending = [...chunks];
  let pulls = 0;
  let canceled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        const chunk = pending.shift();
        if (chunk) controller.enqueue(chunk);
        if (pending.length === 0) controller.close();
      },
      cancel() {
        canceled = true;
      },
    },
    { highWaterMark: 0 },
  );

  return {
    request: new Request("http://localhost/items", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
      // @ts-expect-error duplex is required for streaming bodies in Node.
      duplex: "half",
    }),
    pulls: () => pulls,
    canceled: () => canceled,
  };
}

function expectRight<A>(result: ReturnType<typeof decodeJsonlBody<A>>): AsyncIterable<A> {
  expect(result._tag).toBe("Right");
  if (result._tag === "Left") throw result.left;
  return result.right;
}

describe("JSONL request decoding", () => {
  test("lazily decodes UTF-8 records and lossless integers across chunk boundaries", async () => {
    const bytes = new TextEncoder().encode(
      '{"display_name":"café","count":9223372036854775807}\r\n' +
        '{"display_name":"tea","count":2}',
    );
    const splitUtf8 = bytes.indexOf(0xc3) + 1;
    const newline = bytes.indexOf(0x0a);
    const source = streamingRequest([
      bytes.slice(0, splitUtf8),
      bytes.slice(splitUtf8, newline + 1),
      bytes.slice(newline + 1),
    ]);
    const values = expectRight(
      decodeJsonlBody(
        source.request,
        Decoders.object<{ displayName: string; count: bigint }>(
          {
            displayName: Decoders.string,
            count: Decoders.strictBigint,
          },
          { wireNames: { displayName: "display_name" } },
        ),
      ),
    );
    const iterator = values[Symbol.asyncIterator]();

    expect(source.pulls()).toBe(0);
    expect(await iterator.next()).toEqual({
      done: false,
      value: { displayName: "café", count: 9_223_372_036_854_775_807n },
    });
    expect(source.pulls()).toBe(2);
    expect(await iterator.next()).toEqual({
      done: false,
      value: { displayName: "tea", count: 2n },
    });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(source.pulls()).toBe(3);
  });

  test("reports item validation paths and releases an unread source", async () => {
    const source = streamingRequest([
      new TextEncoder().encode('{"name":"ok"}\n{"name":42}\n'),
      new TextEncoder().encode('{"name":"unread"}\n'),
    ]);
    const values = expectRight(
      decodeJsonlBody(source.request, Decoders.object<{ name: string }>({ name: Decoders.string })),
    );
    const iterator = values[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ done: false, value: { name: "ok" } });
    let failure: unknown;
    try {
      await iterator.next();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ValidationError);
    expect((failure as ValidationError).issues).toEqual([
      { path: "$body[1].name", message: "Expected a string." },
    ]);
    expect(source.pulls()).toBe(1);
    expect(source.request.body!.locked).toBe(false);
    expect(source.canceled()).toBe(false);
  });

  test("reports indexed JSON syntax and UTF-8 failures", async () => {
    const syntaxSource = streamingRequest([new TextEncoder().encode('{"name":"ok"}\nnot-json\n')]);
    const syntaxValues = expectRight(
      decodeJsonlBody(
        syntaxSource.request,
        Decoders.object<{ name: string }>({ name: Decoders.string }),
      ),
    );
    const syntaxIterator = syntaxValues[Symbol.asyncIterator]();
    expect(await syntaxIterator.next()).toEqual({ done: false, value: { name: "ok" } });
    await expect(syntaxIterator.next()).rejects.toMatchObject({
      issues: [{ path: "$body[1]", message: "JSONL item must contain one valid JSON value." }],
    });

    const utf8Source = streamingRequest([new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d])]);
    const utf8Values = expectRight(decodeJsonlBody(utf8Source.request, Decoders.unknown));
    await expect(utf8Values[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      issues: [{ path: "$body[0]", message: "JSONL body must contain valid UTF-8." }],
    });

    const bomSource = streamingRequest([new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d, 0x0a])]);
    const bomValues = expectRight(decodeJsonlBody(bomSource.request, Decoders.unknown));
    await expect(bomValues[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      issues: [{ path: "$body[0]", message: "JSONL item must contain one valid JSON value." }],
    });

    const brokenBody = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.error(new Error("connection failed"));
        },
      },
      { highWaterMark: 0 },
    );
    const brokenRequest = new Request("http://localhost/items", {
      method: "POST",
      headers: { "content-type": "application/jsonl" },
      body: brokenBody,
      // @ts-expect-error duplex is required for streaming bodies in Node.
      duplex: "half",
    });
    const brokenValues = expectRight(decodeJsonlBody(brokenRequest, Decoders.unknown));
    await expect(brokenValues[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      issues: [{ path: "$body[0]", message: "JSONL body could not be read." }],
    });
  });

  test("checks media type, body presence, and byte limits at the correct boundary", async () => {
    const wrongMedia = streamingRequest([new TextEncoder().encode("{}\n")], "application/json");
    const unsupported = decodeJsonlBody(wrongMedia.request, Decoders.unknown);
    expect(unsupported._tag).toBe("Left");
    if (unsupported._tag === "Left") {
      expect(unsupported.left).toBeInstanceOf(UnsupportedMediaTypeError);
    }
    expect(wrongMedia.pulls()).toBe(0);

    const missing = decodeJsonlBody(
      new Request("http://localhost/items", {
        method: "POST",
        headers: { "content-type": "application/jsonl" },
      }),
      Decoders.unknown,
    );
    expect(missing._tag).toBe("Left");
    if (missing._tag === "Left") {
      expect(missing.left).toBeInstanceOf(ValidationError);
    }

    const declared = decodeJsonlBody(
      new Request("http://localhost/items", {
        method: "POST",
        headers: {
          "content-type": "application/jsonl",
          "content-length": "100",
        },
        body: "{}",
      }),
      Decoders.unknown,
      { maxRequestBodyBytes: 10 },
    );
    expect(declared._tag).toBe("Left");
    if (declared._tag === "Left") {
      expect(declared.left).toBeInstanceOf(RequestBodyTooLargeError);
    }

    const streamed = streamingRequest([new TextEncoder().encode('{"value":"too large"}\n')]);
    const streamedValues = expectRight(
      decodeJsonlBody(streamed.request, Decoders.unknown, { maxRequestBodyBytes: 5 }),
    );
    await expect(streamedValues[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
  });

  test("releases but does not cancel the source when a consumer stops early", async () => {
    const source = streamingRequest([
      new TextEncoder().encode('{"name":"first"}\n'),
      new TextEncoder().encode('{"name":"second"}\n'),
    ]);
    const values = expectRight(
      decodeJsonlBody(source.request, Decoders.object<{ name: string }>({ name: Decoders.string })),
    );
    const iterator = values[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ done: false, value: { name: "first" } });
    await iterator.return?.();

    expect(source.pulls()).toBe(1);
    expect(source.request.body!.locked).toBe(false);
    expect(source.canceled()).toBe(false);
  });

  test("combines request parameters with the lazy body and preserves boundary precedence", async () => {
    const requestDecoder = RequestDecoders.path("id", Decoders.integer).map((id) => ({ id }));
    const itemDecoder = Decoders.object<{ name: string }>({ name: Decoders.string });
    const source = streamingRequest([new TextEncoder().encode('{"name":"first"}\n')]);
    const combined = decodeRequestInputAndJsonlBody(
      requestDecoder,
      itemDecoder,
      "body",
      source.request,
      { id: "42" },
    );

    expect(combined._tag).toBe("Right");
    if (combined._tag === "Right") {
      expect(combined.right.id).toBe(42);
      const items: Array<{ name: string }> = [];
      for await (const item of combined.right.body) items.push(item);
      expect(items).toEqual([{ name: "first" }]);
    }

    const invalid = decodeRequestInputAndJsonlBody(
      requestDecoder,
      itemDecoder,
      "body",
      new Request("http://localhost/items", {
        method: "POST",
        headers: { "content-type": "application/jsonl" },
      }),
      { id: "invalid" },
    );
    expect(invalid._tag).toBe("Left");
    if (invalid._tag === "Left") {
      expect(invalid.left).toBeInstanceOf(ValidationError);
      expect((invalid.left as ValidationError).issues).toEqual([
        { path: "$path.id", message: "Expected a finite number." },
        { path: "$body", message: "Required body is missing." },
      ]);
    }

    const unsupported = decodeRequestInputAndJsonlBody(
      requestDecoder,
      itemDecoder,
      "body",
      streamingRequest([new TextEncoder().encode("{}\n")], "application/json").request,
      { id: "invalid" },
    );
    expect(unsupported._tag).toBe("Left");
    if (unsupported._tag === "Left") {
      expect(unsupported.left).toBeInstanceOf(UnsupportedMediaTypeError);
    }
  });

  test("surfaces lazy item and size failures through the HTTP router", async () => {
    const decoder = Decoders.object<{ name: string }>({ name: Decoders.string });
    const operation: ServerOperation<AsyncIterable<{ name: string }>, void> = {
      endpoint: {
        service: { name: "JsonlService", hints: emptyHints() },
        namespaces: [],
        operation: {
          name: "send",
          operationId: "JsonlService.send",
          method: "POST",
          path: "/items",
          hints: emptyHints(),
        },
      },
      decodeInput(request) {
        return decodeJsonlBody(request, decoder, { maxRequestBodyBytes: 30 });
      },
      encodeResult() {
        return new Response(null, { status: 204 });
      },
    };
    const router = createHttpRouter([
      bindRoute(operation, async (values) => {
        for await (const _value of values) {
          // Consume within the request lifetime so lazy failures become HTTP responses.
        }
      }),
    ]);

    const invalid = await router.handle(
      new Request("http://localhost/items", {
        method: "POST",
        headers: { "content-type": "application/jsonl" },
        body: '{"name":"ok"}\n{"name":42}\n',
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: "Invalid request",
      issues: [{ path: "$body[1].name", message: "Expected a string." }],
    });

    const tooLarge = await router.handle(
      new Request("http://localhost/items", {
        method: "POST",
        headers: { "content-type": "application/jsonl" },
        body: '{"name":"this record is too large"}\n',
      }),
    );
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({ error: "Content Too Large", maxBytes: 30 });
  });
});
