import { describe, expect, test } from "bun:test";
import {
  Decoders,
  Either,
  UnsupportedMediaTypeError,
  ValidationError,
  decodeRequestInput,
  decodeRequestInputAndBody,
  isLeft,
  RequestDecoders,
} from "../src/server.js";
import type { RequestDecoder } from "../src/server.js";

describe("http request decoders (sync)", () => {
  test("RequestDecoders.combine builds typed objects applicatively", () => {
    const decoder = RequestDecoders.combine(
      [
        RequestDecoders.path("petId", Decoders.string),
        RequestDecoders.query("limit", Decoders.number.optional()),
        RequestDecoders.header("x-trace-id", Decoders.string.optional()),
      ],
      (petId, limit, traceId) => ({ petId, limit, traceId }),
    );
    const typedDecoder: RequestDecoder<{
      petId: string;
      limit?: number;
      traceId?: string;
    }> = decoder;
    void typedDecoder;

    const decoded = decoder.decode({
      pathParams: { petId: "p-1" },
      query: new URLSearchParams("limit=2"),
      headers: new Headers({ "x-trace-id": "trace-1" }),
    });

    expect(decoded).toEqual(Either.right({
      petId: "p-1",
      limit: 2,
      traceId: "trace-1",
    }));
  });

  test("accumulates request validation issues synchronously", () => {
    const decoder = RequestDecoders.combine(
      [
        RequestDecoders.path("petId", Decoders.string),
        RequestDecoders.query("limit", Decoders.number),
      ],
      (petId, limit) => ({ petId, limit }),
    );

    const decoded = decoder.decode({
      pathParams: {},
      query: new URLSearchParams("limit=bad"),
      headers: new Headers(),
    });

    expect(decoded._tag).toBe("Left");
    if (decoded._tag === "Left") {
      expect(decoded.left).toEqual([
        { path: "$path.petId", message: "Expected a string." },
        { path: "$query.limit", message: "Expected a finite number." },
      ]);
    }
  });

  test("decodeRequestInput returns Either.right on success", () => {
    const decoder = RequestDecoders.path("petId", Decoders.string)
      .map((petId) => ({ petId }));

    const result = decodeRequestInput(
      decoder,
      new Request("http://localhost/pets/p-1"),
      { petId: "p-1" },
    );

    expect(result).toEqual(Either.right({ petId: "p-1" }));
  });

  test("decodeRequestInput returns Either.left on failure", () => {
    const decoder = RequestDecoders.combine(
      [RequestDecoders.path("petId", Decoders.string)],
      (petId) => ({ petId }),
    );

    const result = decodeRequestInput(
      decoder,
      new Request("http://localhost/pets"),
      {},
    );

    expect(isLeft(result)).toBe(true);
    if (isLeft(result)) {
      expect(result.left).toBeInstanceOf(ValidationError);
    }
  });

  test("decodeRequestInput returns validation error for malformed path encoding", () => {
    const decoder = RequestDecoders.path("petId", Decoders.string)
      .map((petId) => ({ petId }));

    const result = decodeRequestInput(
      decoder,
      new Request("http://localhost/pets/%E0%A4%A"),
      { petId: "%E0%A4%A" },
    );

    expect(isLeft(result)).toBe(true);
    if (isLeft(result)) {
      expect(result.left.issues).toEqual([
        {
          path: "$path.petId",
          message: "Expected a valid percent-encoded path segment.",
        },
      ]);
    }
  });

  test("Decoder.map lifts one request value into an object", () => {
    const decoder = RequestDecoders.path("petId", Decoders.string)
      .map((petId) => ({ petId }));

    const decoded = decoder.decode({
      pathParams: { petId: "p-1" },
      query: new URLSearchParams(),
      headers: new Headers(),
    });

    expect(decoded).toEqual(Either.right({ petId: "p-1" }));
  });

  test("decodeRequestInputAndBody returns Either.right merging request input and body", async () => {
    const requestDecoder = RequestDecoders.path("petId", Decoders.string)
      .map((petId) => ({ petId }));
    const bodyDecoder = Decoders.object<{ name: string }>({
      name: Decoders.string,
    });

    const result = await decodeRequestInputAndBody(
      requestDecoder,
      bodyDecoder,
      new Request("http://localhost/pets/p-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Milo" }),
      }),
      { petId: "p-1" },
    );

    expect(result).toEqual(Either.right({ petId: "p-1", name: "Milo" }));
  });

  test("decodeRequestInputAndBody accumulates errors from both as Left", async () => {
    const requestDecoder = RequestDecoders.combine(
      [RequestDecoders.path("petId", Decoders.string)],
      (petId) => ({ petId }),
    );
    const bodyDecoder = Decoders.object<{ name: string }>({
      name: Decoders.string,
    });

    const result = await decodeRequestInputAndBody(
      requestDecoder,
      bodyDecoder,
      new Request("http://localhost/pets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: 42 }),
      }),
      {},
    );

    expect(isLeft(result)).toBe(true);
    if (isLeft(result)) {
      expect(result.left).toBeInstanceOf(ValidationError);
      const err = result.left as ValidationError;
      expect(err.issues).toEqual([
        { path: "$path.petId", message: "Expected a string." },
        { path: "$body.name", message: "Expected a string." },
      ]);
    }
  });

  test("decodeRequestInputAndBody short-circuits with 415 on bad Content-Type", async () => {
    const requestDecoder = RequestDecoders.combine(
      [RequestDecoders.path("petId", Decoders.string)],
      (petId) => ({ petId }),
    );
    const bodyDecoder = Decoders.object<{ name: string }>({
      name: Decoders.string,
    });

    // Both inputs are invalid: missing path param AND wrong Content-Type.
    // The 415 must take precedence and request-input errors must NOT be merged in.
    const result = await decodeRequestInputAndBody(
      requestDecoder,
      bodyDecoder,
      new Request("http://localhost/pets", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "not-json",
      }),
      {},
      { contentTypes: ["application/json"] },
    );

    expect(isLeft(result)).toBe(true);
    if (isLeft(result)) {
      expect(result.left).toBeInstanceOf(UnsupportedMediaTypeError);
      expect(result.left).not.toBeInstanceOf(ValidationError);
      expect((result.left as UnsupportedMediaTypeError).received).toBe("text/plain");
    }
  });

  test("requiredHeader decodes present header and fails on missing", () => {
    const decoder = RequestDecoders.combine(
      [RequestDecoders.header("x-api-key", Decoders.string)],
      (apiKey) => ({ apiKey }),
    );

    const ok = decoder.decode({
      pathParams: {},
      query: new URLSearchParams(),
      headers: new Headers({ "x-api-key": "secret" }),
    });
    expect(ok).toEqual(Either.right({ apiKey: "secret" }));

    const missing = decoder.decode({
      pathParams: {},
      query: new URLSearchParams(),
      headers: new Headers(),
    });
    expect(isLeft(missing)).toBe(true);
    if (isLeft(missing)) {
      expect(missing.left).toEqual([
        { path: "$header.x-api-key", message: "Expected a string." },
      ]);
    }
  });

  test("requiredCookie decodes present cookie and fails on missing", () => {
    const decoder = RequestDecoders.combine(
      [RequestDecoders.cookie("session", Decoders.string)],
      (session) => ({ session }),
    );

    const ok = decodeRequestInput(
      decoder,
      new Request("http://localhost/test", {
        headers: { cookie: "session=abc123; theme=dark" },
      }),
      {},
    );
    expect(ok).toEqual(Either.right({ session: "abc123" }));

    const missing = decodeRequestInput(
      decoder,
      new Request("http://localhost/test"),
      {},
    );
    expect(isLeft(missing)).toBe(true);
  });

  test("optional cookie returns undefined when absent", () => {
    const decoder = RequestDecoders.combine(
      [RequestDecoders.cookie("token", Decoders.string.optional())],
      (token) => ({ token }),
    );

    const result = decodeRequestInput(
      decoder,
      new Request("http://localhost/test"),
      {},
    );
    expect(result).toEqual(Either.right({ token: undefined }));
  });

  test("cookie with empty value decodes as empty string", () => {
    const decoder = RequestDecoders.cookie("sid", Decoders.string);

    const result = decodeRequestInput(
      decoder.map((sid) => ({ sid })),
      new Request("http://localhost/test", {
        headers: { cookie: "sid=; other=val" },
      }),
      {},
    );
    expect(result).toEqual(Either.right({ sid: "" }));
  });

  test("cookie parsing handles whitespace around values", () => {
    const decoder = RequestDecoders.cookie("token", Decoders.string);

    const result = decodeRequestInput(
      decoder.map((token) => ({ token })),
      new Request("http://localhost/test", {
        headers: { cookie: " token = abc123 ; other=x" },
      }),
      {},
    );
    expect(result).toEqual(Either.right({ token: "abc123" }));
  });

  test("cookie parsing skips malformed pairs without =", () => {
    const decoder = RequestDecoders.cookie("good", Decoders.string);

    const result = decodeRequestInput(
      decoder.map((good) => ({ good })),
      new Request("http://localhost/test", {
        headers: { cookie: "malformed; good=yes" },
      }),
      {},
    );
    expect(result).toEqual(Either.right({ good: "yes" }));
  });

  test("decodeRequestInputAndBody accumulates request + body errors", async () => {
    const requestDecoder = RequestDecoders.combine(
      [
        RequestDecoders.path("id", Decoders.string),
        RequestDecoders.query("limit", Decoders.number),
      ],
      (id, limit) => ({ id, limit }),
    );
    const bodyDecoder = Decoders.object<{ name: string; count: number }>({
      name: Decoders.string,
      count: Decoders.number,
    });

    const result = await decodeRequestInputAndBody(
      requestDecoder,
      bodyDecoder,
      new Request("http://localhost/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: 42, count: "bad" }),
      }),
      {},
    );

    expect(isLeft(result)).toBe(true);
    if (isLeft(result)) {
      expect(result.left).toBeInstanceOf(ValidationError);
      // Should have errors from both request params and body
      expect((result.left as ValidationError).issues.length).toBeGreaterThanOrEqual(3);
    }
  });
});
