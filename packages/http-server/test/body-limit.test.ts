import { describe, expect, test } from "bun:test";
import {
  type BodyDecoderMap,
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  Decoders,
  Decoder,
  Either,
  RequestDecoders,
  RequestBodyTooLargeError,
  bindRoute,
  createHttpRouter,
  decodeBody,
  decodeRequestInputAndBody,
  emptyHints,
  type ServerOperation,
} from "../src/server.js";
import { resolveRequestBodyLimit } from "../src/http/body-limit.js";

const encoder = new TextEncoder();

function bodyRequest(
  contentType: string,
  chunks: readonly (string | Uint8Array)[],
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost/body", {
    method: "POST",
    headers: {
      "content-type": contentType,
      ...headers,
    },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        }
        controller.close();
      },
    }),
    // @ts-expect-error duplex is required for streaming bodies in Node.
    duplex: "half",
  });
}

function expectTooLarge(result: Awaited<ReturnType<typeof decodeBody>>): RequestBodyTooLargeError {
  expect(result._tag).toBe("Left");
  if (result._tag === "Right") throw new Error("Expected request body rejection.");
  expect(result.left).toBeInstanceOf(RequestBodyTooLargeError);
  return result.left as RequestBodyTooLargeError;
}

describe("request body limits", () => {
  test("uses a documented finite 10 MiB default and validates overrides", () => {
    expect(DEFAULT_MAX_REQUEST_BODY_BYTES).toBe(10 * 1024 * 1024);
    expect(resolveRequestBodyLimit()).toBe(DEFAULT_MAX_REQUEST_BODY_BYTES);
    expect(resolveRequestBodyLimit(0)).toBe(0);
    expect(resolveRequestBodyLimit(false)).toBe(false);

    for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveRequestBodyLimit(invalid)).toThrow(RangeError);
    }
  });

  test("enforces the finite default when no direct override is provided", async () => {
    const result = await decodeBody(
      bodyRequest("text/plain", ["small"], {
        "content-length": String(DEFAULT_MAX_REQUEST_BODY_BYTES + 1),
      }),
      { text: Decoders.string },
    );

    const error = expectTooLarge(result);
    expect(error.maxBytes).toBe(DEFAULT_MAX_REQUEST_BODY_BYTES);
  });

  test("applies exact and over-by-one semantics to every buffered body representation", async () => {
    const multipart =
      '--b\r\nContent-Disposition: form-data; name="value"\r\n\r\nhello\r\n--b--\r\n';
    const cases: readonly {
      readonly name: string;
      readonly contentType: string;
      readonly body: string | Uint8Array;
      readonly decoders: BodyDecoderMap<unknown>;
    }[] = [
      {
        name: "JSON",
        contentType: "application/json",
        body: '{"value":1}',
        decoders: { json: Decoders.unknown },
      },
      {
        name: "text",
        contentType: "text/plain",
        body: "hello",
        decoders: { text: Decoders.string },
      },
      {
        name: "form",
        contentType: "application/x-www-form-urlencoded",
        body: "value=hello",
        decoders: { form: Decoders.unknown },
      },
      {
        name: "multipart",
        contentType: "multipart/form-data; boundary=b",
        body: multipart,
        decoders: { multipart: Decoders.unknown },
      },
      {
        name: "binary",
        contentType: "application/octet-stream",
        body: new Uint8Array([0, 1, 2, 3]),
        decoders: { binary: Decoders.bytes },
      },
      {
        name: "File",
        contentType: "application/octet-stream",
        body: new Uint8Array([4, 5, 6, 7]),
        decoders: { file: Decoders.file },
      },
    ];

    for (const testCase of cases) {
      const bytes =
        typeof testCase.body === "string" ? encoder.encode(testCase.body) : testCase.body;
      const exact = await decodeBody(
        bodyRequest(testCase.contentType, [bytes]),
        testCase.decoders,
        { maxRequestBodyBytes: bytes.byteLength },
      );
      expect(exact._tag, `${testCase.name} should succeed exactly at its limit`).toBe("Right");

      const over = await decodeBody(bodyRequest(testCase.contentType, [bytes]), testCase.decoders, {
        maxRequestBodyBytes: bytes.byteLength - 1,
      });
      const error = expectTooLarge(over);
      expect(error.maxBytes).toBe(bytes.byteLength - 1);
      expect(error.receivedBytes).toBe(bytes.byteLength);
    }
  });

  test("rejects a valid oversized Content-Length before decoding and safely drains", async () => {
    let decoded = false;
    let pulls = 0;
    let drained!: () => void;
    const drainedPromise = new Promise<void>((resolve) => {
      drained = resolve;
    });
    const decoder = Decoder.of((input) => {
      decoded = true;
      return Either.right(input);
    });
    const request = new Request("http://localhost/body", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "content-length": "100",
      },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          if (pulls === 1) controller.enqueue(encoder.encode("payload"));
          else {
            controller.close();
            drained();
          }
        },
      }),
      // @ts-expect-error duplex is required for streaming bodies in Node.
      duplex: "half",
    });

    const error = expectTooLarge(
      await decodeBody(request, { text: decoder }, { maxRequestBodyBytes: 7 }),
    );
    expect(error.declaredBytes).toBe("100");
    expect(decoded).toBe(false);
    await drainedPromise;
    expect(pulls).toBe(2);
    expect(await error.toResponse().json()).toEqual({
      error: "Content Too Large",
      maxBytes: 7,
    });
  });

  test("counts missing, invalid, and misleading Content-Length values while streaming", async () => {
    for (const contentLength of [undefined, "invalid", "2"]) {
      const headers = contentLength === undefined ? {} : { "content-length": contentLength };
      const result = await decodeBody(
        bodyRequest("text/plain", ["abc", "def"], headers),
        { text: Decoders.string },
        { maxRequestBodyBytes: 5 },
      );

      const error = expectTooLarge(result);
      expect(error.declaredBytes).toBeUndefined();
      expect(error.receivedBytes).toBe(6);
    }
  });

  test("counts optional-body probe bytes once and preserves exact boundaries", async () => {
    const chunks = ["{", '"value":1}'];
    const byteLength = chunks.reduce((total, chunk) => total + encoder.encode(chunk).byteLength, 0);
    const decoder = Decoders.object<{ value: number }>({
      value: Decoders.strictInteger,
    });

    const exact = await decodeBody(
      bodyRequest("application/json", chunks),
      { json: decoder },
      { optional: true, maxRequestBodyBytes: byteLength },
    );
    expect(exact).toEqual(Either.right({ value: 1 }));

    const over = await decodeBody(
      bodyRequest("application/json", chunks),
      { json: decoder },
      { optional: true, maxRequestBodyBytes: byteLength - 1 },
    );
    expectTooLarge(over);
  });

  test("releases optional replay and upstream readers synchronously on an early 415", async () => {
    let pulls = 0;
    const request = new Request("http://localhost/body", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls++;
            controller.enqueue(encoder.encode("present"));
          },
        },
        { highWaterMark: 0 },
      ),
      // @ts-expect-error duplex is required for streaming bodies in Node.
      duplex: "half",
    });

    const result = await decodeBody(
      request,
      { json: Decoders.unknown },
      {
        optional: true,
        contentTypes: ["application/json"],
      },
    );

    expect(result._tag).toBe("Left");
    expect(request.body?.locked).toBe(false);
    expect(pulls).toBe(1);
  });

  test("supports explicit direct-decoder disable behavior", async () => {
    const result = await decodeBody(
      bodyRequest("text/plain", ["ok"], {
        "content-length": String(DEFAULT_MAX_REQUEST_BODY_BYTES + 1),
      }),
      { text: Decoders.string },
      { maxRequestBodyBytes: false },
    );

    expect(result).toEqual(Either.right("ok"));
  });

  test("returns structured 413 responses through router defaults, overrides, and disable", async () => {
    const operation: ServerOperation<string, string> = {
      endpoint: {
        service: { name: "BodyService", hints: emptyHints() },
        namespaces: [],
        operation: {
          name: "echo",
          operationId: "Body.echo",
          method: "POST",
          path: "/body",
          hints: emptyHints(),
        },
      },
      decodeInput(request) {
        return decodeBody(request, { text: Decoders.string }, { contentTypes: ["text/plain"] });
      },
      encodeResult(result) {
        return new Response(result);
      },
    };

    const limited = createHttpRouter([bindRoute(operation, async (input) => input)], {
      maxRequestBodyBytes: 5,
    });
    const exact = await limited.handle(bodyRequest("text/plain", ["hello"]));
    expect(exact.status).toBe(200);
    expect(await exact.text()).toBe("hello");

    const over = await limited.handle(bodyRequest("text/plain", ["hello", "!"]));
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({
      error: "Content Too Large",
      maxBytes: 5,
    });

    const raised = createHttpRouter([bindRoute(operation, async (input) => input)], {
      maxRequestBodyBytes: DEFAULT_MAX_REQUEST_BODY_BYTES + 10,
    });
    const inheritedOverride = await raised.handle(
      bodyRequest("text/plain", ["ok"], {
        "content-length": String(DEFAULT_MAX_REQUEST_BODY_BYTES + 1),
      }),
    );
    expect(inheritedOverride.status).toBe(200);

    const disabled = createHttpRouter([bindRoute(operation, async (input) => input)], {
      maxRequestBodyBytes: false,
    });
    const inheritedDisable = await disabled.handle(
      bodyRequest("text/plain", ["ok"], {
        "content-length": String(DEFAULT_MAX_REQUEST_BODY_BYTES + 1),
      }),
    );
    expect(inheritedDisable.status).toBe(200);
  });

  test("decoder policy can tighten but cannot weaken an enclosing router limit", async () => {
    function operationWithDecoderLimit(
      maxRequestBodyBytes: number | false,
    ): ServerOperation<string, string> {
      return {
        endpoint: {
          service: { name: "BodyService", hints: emptyHints() },
          namespaces: [],
          operation: {
            name: "echo",
            operationId: "Body.echo",
            method: "POST",
            path: "/body",
            hints: emptyHints(),
          },
        },
        decodeInput(request) {
          return decodeBody(
            request,
            { text: Decoders.string },
            { contentTypes: ["text/plain"], maxRequestBodyBytes },
          );
        },
        encodeResult(result) {
          return new Response(result);
        },
      };
    }

    for (const decoderLimit of [false, 10] as const) {
      const router = createHttpRouter(
        [bindRoute(operationWithDecoderLimit(decoderLimit), async (input) => input)],
        { maxRequestBodyBytes: 5 },
      );
      const response = await router.handle(bodyRequest("text/plain", ["hello", "!"]));
      expect(response.status, `decoder limit ${decoderLimit} must not weaken router limit`).toBe(
        413,
      );
    }

    const tightened = createHttpRouter(
      [bindRoute(operationWithDecoderLimit(5), async (input) => input)],
      { maxRequestBodyBytes: 10 },
    );
    const tightenedResponse = await tightened.handle(bodyRequest("text/plain", ["hello", "!"]));
    expect(tightenedResponse.status).toBe(413);
  });

  test("known oversized bodies take policy precedence over media-type rejection", async () => {
    const result = await decodeBody(
      bodyRequest("application/xml", ["body"], { "content-length": "6" }),
      { text: Decoders.string },
      {
        contentTypes: ["text/plain"],
        maxRequestBodyBytes: 5,
      },
    );

    expectTooLarge(result);
  });

  test("gives body-policy errors precedence over merged request validation", async () => {
    const result = await decodeRequestInputAndBody(
      RequestDecoders.header("x-required", Decoders.string).map((value) => ({
        required: value,
      })),
      {
        text: Decoders.string.map((value) => ({ value })),
      },
      bodyRequest("text/plain", ["too", "long"]),
      {},
      { maxRequestBodyBytes: 5 },
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Right") throw new Error("Expected request body rejection.");
    expect(result.left).toBeInstanceOf(RequestBodyTooLargeError);
  });

  test("handle rejects known oversized unmatched bodies while tryHandle preserves fallthrough", async () => {
    const router = createHttpRouter([], { maxRequestBodyBytes: 5 });
    const oversized = () => bodyRequest("text/plain", ["body"], { "content-length": "6" });

    const handled = await router.handle(oversized());
    expect(handled.status).toBe(413);
    expect(await handled.json()).toEqual({
      error: "Content Too Large",
      maxBytes: 5,
    });

    expect(await router.tryHandle(oversized())).toBeUndefined();
  });
});
