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
import type { Decoder, RequestDecoder } from "../src/server.js";

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

    expect(decoded).toEqual(
      Either.right({
        petId: "p-1",
        limit: 2,
        traceId: "trace-1",
      }),
    );
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
    const decoder = RequestDecoders.path("petId", Decoders.string).map((petId) => ({ petId }));

    const result = decodeRequestInput(decoder, new Request("http://localhost/pets/p-1"), {
      petId: "p-1",
    });

    expect(result).toEqual(Either.right({ petId: "p-1" }));
  });

  test("decodeRequestInput returns Either.left on failure", () => {
    const decoder = RequestDecoders.combine(
      [RequestDecoders.path("petId", Decoders.string)],
      (petId) => ({ petId }),
    );

    const result = decodeRequestInput(decoder, new Request("http://localhost/pets"), {});

    expect(isLeft(result)).toBe(true);
    if (isLeft(result)) {
      expect(result.left).toBeInstanceOf(ValidationError);
    }
  });

  test("decodeRequestInput returns validation error for malformed path encoding", () => {
    const decoder = RequestDecoders.path("petId", Decoders.string).map((petId) => ({ petId }));

    const result = decodeRequestInput(decoder, new Request("http://localhost/pets/%E0%A4%A"), {
      petId: "%E0%A4%A",
    });

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

  test("path arrays split configured raw separators before percent decoding", () => {
    const decoder = RequestDecoders.path("labelValues", Decoders.array(Decoders.string), {
      array: true,
      arraySeparator: ".",
    });

    expect(
      decodeRequestInput(decoder, new Request("http://localhost/items"), {
        labelValues: "a.b%2Ec",
      }),
    ).toEqual(Either.right(["a", "b.c"]));

    const malformed = decodeRequestInput(decoder, new Request("http://localhost/items"), {
      labelValues: "a.%E0%A4%A",
    });
    expect(malformed._tag).toBe("Left");
    if (malformed._tag === "Left") {
      expect(malformed.left.issues).toEqual([
        {
          path: "$path.labelValues[1]",
          message: "Expected a valid percent-encoded path segment.",
        },
      ]);
    }
  });

  test("path array separators require a non-empty array configuration", () => {
    expect(() => RequestDecoders.path("values", Decoders.string, { arraySeparator: "." })).toThrow(
      "Path array separators require array decoding.",
    );
    expect(() =>
      RequestDecoders.path("values", Decoders.array(Decoders.string), {
        array: true,
        arraySeparator: "",
      }),
    ).toThrow("Path array separators must not be empty.");
  });

  test("array parameters follow their HTTP comma and explode formats", () => {
    const decoder = RequestDecoders.combine(
      [
        RequestDecoders.path("pathIds", Decoders.array(Decoders.string), { array: true }),
        RequestDecoders.query("compact", Decoders.array(Decoders.string), {
          array: true,
          explode: false,
        }),
        RequestDecoders.query("expanded", Decoders.array(Decoders.string), {
          array: true,
          explode: true,
        }),
        RequestDecoders.header("x-values", Decoders.array(Decoders.string), { array: true }),
        RequestDecoders.cookie("choices", Decoders.array(Decoders.string), { array: true }),
      ],
      (pathIds, compact, expanded, headerValues, choices) => ({
        pathIds,
        compact,
        expanded,
        headerValues,
        choices,
      }),
    );

    const result = decodeRequestInput(
      decoder,
      new Request(
        "http://localhost/items/a,b%2Cc?compact=one,two%2Cthree&expanded=red&expanded=blue",
        {
          headers: {
            cookie: "choices=yes,no",
            "x-values": "first, second",
          },
        },
      ),
      { pathIds: "a,b%2Cc" },
    );

    expect(result).toEqual(
      Either.right({
        pathIds: ["a", "b,c"],
        compact: ["one", "two,three"],
        expanded: ["red", "blue"],
        headerValues: ["first", "second"],
        choices: ["yes", "no"],
      }),
    );
  });

  test("rejects repeated non-exploded query array parameters", () => {
    const decoder = RequestDecoders.query("ids", Decoders.array(Decoders.integer), {
      array: true,
      explode: false,
    });

    const result = decodeRequestInput(
      decoder,
      new Request("http://localhost/items?ids=1,2&ids=999"),
      {},
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.issues).toEqual([
        {
          path: "$query.ids",
          message: "Expected one comma-delimited query parameter.",
        },
      ]);
    }
  });

  test("trims raw non-exploded query items while preserving encoded commas", () => {
    const decoder = RequestDecoders.query("values", Decoders.array(Decoders.string), {
      array: true,
      explode: false,
    });

    const result = decodeRequestInput(
      decoder,
      new Request("http://localhost/items?values=%20one%20,%20two%2Cthree%20"),
      {},
    );

    expect(result).toEqual(Either.right(["one", "two,three"]));
  });

  test("rejects malformed encoding in a non-exploded query array", () => {
    const decoder = RequestDecoders.query("values", Decoders.array(Decoders.string), {
      array: true,
      explode: false,
    });

    const result = decodeRequestInput(
      decoder,
      new Request("http://localhost/items?values=one,%E0%A4%A"),
      {},
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.issues).toEqual([
        {
          path: "$query.values[1]",
          message: "Expected a valid percent-encoded query value.",
        },
      ]);
    }
  });

  test("rejects malformed encoding in scalar and exploded query values", () => {
    const scalar = RequestDecoders.query("value", Decoders.string);
    const exploded = RequestDecoders.query("values", Decoders.array(Decoders.string), {
      array: true,
      explode: true,
    });

    for (const url of [
      "http://localhost/items?value=%ZZ",
      "http://localhost/items?value=%E0%A4%A",
    ]) {
      const result = decodeRequestInput(scalar, new Request(url), {});
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left.issues).toEqual([
          {
            path: "$query.value",
            message: "Expected a valid percent-encoded query value.",
          },
        ]);
      }
    }

    const result = decodeRequestInput(
      exploded,
      new Request("http://localhost/items?values=valid&values=%E0%A4%A"),
      {},
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.issues).toEqual([
        {
          path: "$query.values[1]",
          message: "Expected a valid percent-encoded query value.",
        },
      ]);
    }
  });

  test("strict query decoding preserves valid form encoding and ignores undeclared keys", () => {
    const decoder = RequestDecoders.combine(
      [
        RequestDecoders.query("value", Decoders.string),
        RequestDecoders.query("values", Decoders.array(Decoders.string), {
          array: true,
          explode: true,
        }),
      ],
      (value, values) => ({ value, values }),
    );

    const result = decodeRequestInput(
      decoder,
      new Request(
        "http://localhost/items?ignored=%ZZ&%76alue=hello+world%2B%E2%9C%93&values=a%2Cb&values=c+d",
      ),
      {},
    );

    expect(result).toEqual(
      Either.right({
        value: "hello world+✓",
        values: ["a,b", "c d"],
      }),
    );
  });

  test("Decoder.map lifts one request value into an object", () => {
    const decoder = RequestDecoders.path("petId", Decoders.string).map((petId) => ({ petId }));

    const decoded = decoder.decode({
      pathParams: { petId: "p-1" },
      query: new URLSearchParams(),
      headers: new Headers(),
    });

    expect(decoded).toEqual(Either.right({ petId: "p-1" }));
  });

  test("decodeRequestInputAndBody returns Either.right merging request input and body", async () => {
    const requestDecoder = RequestDecoders.path("petId", Decoders.string).map((petId) => ({
      petId,
    }));
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

  test("decodeRequestInputAndBody mirrors relocated raw-file names after input decoding", async () => {
    const requestDecoder = RequestDecoders.query("filename", Decoders.string).map((filename) => ({
      filename,
    }));
    const bodyDecoder = {
      file: Decoders.file.map((file) => ({ body: file })),
    };

    const result = await decodeRequestInputAndBody(
      requestDecoder,
      bodyDecoder,
      new Request("http://localhost/upload?filename=query.bin", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([1, 2]),
      }),
      {},
      {
        contentTypes: ["application/octet-stream"],
        allowMissingContentType: true,
        fileNameProperty: "filename",
        fileBodyProperty: "body",
      },
    );

    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right.filename).toBe("query.bin");
      expect(result.right.body.name).toBe("query.bin");
      expect(result.right.body.type).toBe("application/octet-stream");
      expect(new Uint8Array(await result.right.body.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
    }
  });

  test("decodeRequestInputAndBody rejects overlapping request and body properties", async () => {
    const requestDecoder = RequestDecoders.path("id", Decoders.string).map((id) => ({ id }));
    const bodyDecoder = Decoders.object<{ id: string; value: string }>({
      id: Decoders.string,
      value: Decoders.string,
    });

    const result = await decodeRequestInputAndBody(
      requestDecoder,
      bodyDecoder,
      new Request("http://localhost/items/path-id", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "body-id", value: "payload" }),
      }),
      { id: "path-id" },
    );

    expect(isLeft(result)).toBe(true);
    if (isLeft(result)) {
      expect(result.left).toBeInstanceOf(ValidationError);
      expect((result.left as ValidationError).issues).toEqual([
        {
          path: "$body.id",
          message: 'Body property "id" conflicts with another request input.',
        },
      ]);
    }
    expect("right" in result).toBe(false);
  });

  test("decodeRequestInputAndBody only treats own request properties as collisions", async () => {
    const requestDecoder = RequestDecoders.path("source", Decoders.string).map(
      () => Object.create({ id: "prototype-only" }) as Record<string, string>,
    );
    const bodyDecoder = Decoders.object<{ id: string }>({ id: Decoders.string });

    const result = await decodeRequestInputAndBody(
      requestDecoder,
      bodyDecoder,
      new Request("http://localhost/items/source", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "body-id" }),
      }),
      { source: "source" },
    );

    expect(result).toEqual(Either.right({ id: "body-id" }));
  });

  test("decodeRequestInputAndBody accepts a structurally compatible Decoder", async () => {
    const requestDecoder = RequestDecoders.path("petId", Decoders.string).map((petId) => ({
      petId,
    }));
    const bodyDecoder = Decoders.object<{ name: string }>({ name: Decoders.string });
    const foreignBodyDecoder = {
      decode: bodyDecoder.decode.bind(bodyDecoder),
      map: bodyDecoder.map.bind(bodyDecoder),
      refine: bodyDecoder.refine.bind(bodyDecoder),
      validate: bodyDecoder.validate.bind(bodyDecoder),
      optional: bodyDecoder.optional.bind(bodyDecoder),
    } satisfies Decoder<{ name: string }>;

    const result = await decodeRequestInputAndBody(
      requestDecoder,
      foreignBodyDecoder,
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

  test("decodeRequestInputAndBody merges request input when an optional body is absent", async () => {
    const requestDecoder = RequestDecoders.path("petId", Decoders.string).map((petId) => ({
      petId,
    }));
    const bodyDecoder = {
      json: Decoders.object<{ name: string }>({ name: Decoders.string }),
    };

    const result = await decodeRequestInputAndBody(
      requestDecoder,
      bodyDecoder,
      new Request("http://localhost/pets/p-1", { method: "POST" }),
      { petId: "p-1" },
      { contentTypes: ["application/json"], optional: true },
    );

    expect(result).toEqual(Either.right({ petId: "p-1" }));
  });

  test("decodeRequestInputAndBody accepts an absent optional body with a Decoder", async () => {
    const requestDecoder = RequestDecoders.path("petId", Decoders.string).map((petId) => ({
      petId,
    }));
    const bodyDecoder = Decoders.object<{ name: string }>({ name: Decoders.string });

    const result = await decodeRequestInputAndBody(
      requestDecoder,
      bodyDecoder,
      new Request("http://localhost/pets/p-1", { method: "POST" }),
      { petId: "p-1" },
      { contentTypes: ["application/json"], optional: true },
    );

    expect(result).toEqual(Either.right({ petId: "p-1" }));
  });

  test("decodeRequestInputAndBody decodes a present optional body with a Decoder", async () => {
    const requestDecoder = RequestDecoders.path("petId", Decoders.string).map((petId) => ({
      petId,
    }));
    const bodyDecoder = Decoders.object<{ name: string }>({ name: Decoders.string });

    const result = await decodeRequestInputAndBody(
      requestDecoder,
      bodyDecoder,
      new Request("http://localhost/pets/p-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Milo" }),
      }),
      { petId: "p-1" },
      { contentTypes: ["application/json"], optional: true },
    );

    expect(result).toEqual(Either.right({ petId: "p-1", name: "Milo" }));
  });

  test("decodeRequestInputAndBody still rejects an absent required body with a Decoder", async () => {
    const requestDecoder = RequestDecoders.path("petId", Decoders.string).map((petId) => ({
      petId,
    }));
    const bodyDecoder = Decoders.object<{ name: string }>({ name: Decoders.string });

    const result = await decodeRequestInputAndBody(
      requestDecoder,
      bodyDecoder,
      new Request("http://localhost/pets/p-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
      { petId: "p-1" },
      { contentTypes: ["application/json"] },
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ValidationError);
      expect((result.left as ValidationError).issues).toEqual([
        { path: "$body", message: "Body must contain valid JSON." },
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
      expect(missing.left).toEqual([{ path: "$header.x-api-key", message: "Expected a string." }]);
    }
  });

  test("optional headers decode missing values as undefined", () => {
    const source = {
      pathParams: {},
      query: new URLSearchParams(),
      headers: new Headers(),
    };

    expect(RequestDecoders.header("x-trace-id", Decoders.string.optional()).decode(source)).toEqual(
      Either.right(undefined),
    );
    expect(
      RequestDecoders.header("x-values", Decoders.array(Decoders.string).optional(), {
        array: true,
      }).decode(source),
    ).toEqual(Either.right(undefined));
    expect(
      RequestDecoders.header("content-type", Decoders.literal("application/json").optional(), {
        mediaType: true,
      }).decode(source),
    ).toEqual(Either.right(undefined));
  });

  test("content-type header decoding ignores media type parameters", () => {
    const decoder = RequestDecoders.header("content-type", Decoders.literal("text/plain"), {
      mediaType: true,
    }).map((contentType) => ({ contentType }));

    const result = decodeRequestInput(
      decoder,
      new Request("http://localhost/test", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
      {},
    );
    expect(result).toEqual(Either.right({ contentType: "text/plain" }));
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

    const missing = decodeRequestInput(decoder, new Request("http://localhost/test"), {});
    expect(isLeft(missing)).toBe(true);
  });

  test("optional cookie returns undefined when absent", () => {
    const decoder = RequestDecoders.combine(
      [RequestDecoders.cookie("token", Decoders.string.optional())],
      (token) => ({ token }),
    );

    const result = decodeRequestInput(decoder, new Request("http://localhost/test"), {});
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
