import { describe, expect, test } from "bun:test";
import {
  Decoders,
  Either,
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
      expect(result.left.issues).toEqual([
        { path: "$path.petId", message: "Expected a string." },
        { path: "$body.name", message: "Expected a string." },
      ]);
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
});
