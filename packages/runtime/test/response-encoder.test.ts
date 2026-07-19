import { describe, expect, test } from "bun:test";
import { ResponseEncoders } from "../src/server.js";

// ---------------------------------------------------------------------------
// ResponseEncoders
// ---------------------------------------------------------------------------

describe("ResponseEncoders", () => {
  test("json encodes typed output with status", async () => {
    const encoder = ResponseEncoders.json<{ id: string }>(201);
    const response = encoder.encode({ id: "p-1" });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: "p-1" });
  });

  test("json preserves bigint values as JSON integer tokens", async () => {
    const response = ResponseEncoders.json<{ value: bigint }>(200).encode({
      value: 9_223_372_036_854_775_807n,
    });

    expect(await response.text()).toBe('{"value":9223372036854775807}');
  });

  test("json encodes nested bytes as base64 strings", async () => {
    const response = ResponseEncoders.json<{ value: Uint8Array }>(200).encode({
      value: new Uint8Array([1, 2, 255]),
    });

    expect(await response.json()).toEqual({ value: "AQL/" });
  });

  test("json rejects circular values", () => {
    const value: Record<string, unknown> = {};
    value.self = value;

    expect(() => ResponseEncoders.json(200).encode(value)).toThrow("circular");
  });

  test("json serializes sparse arrays as null entries", async () => {
    const value = new Array<unknown>(2);
    value[1] = "present";

    const response = ResponseEncoders.json<unknown[]>(200).encode(value);

    expect(await response.text()).toBe('[null,"present"]');
  });

  test("json handles toJSON methods that return their receiver", async () => {
    const value = {
      value: 42,
      toJSON() {
        return this;
      },
    };

    const response = ResponseEncoders.json(200).encode(value);

    expect(await response.json()).toEqual({ value: 42 });
  });

  test("empty encodes no body", async () => {
    const response = ResponseEncoders.empty(204).encode(undefined);

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  test("text encodes string body", async () => {
    const response = ResponseEncoders.text(202).encode("accepted");

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("accepted");
  });

  test("bytes encodes binary body", async () => {
    const response = ResponseEncoders.bytes(200).encode(new Uint8Array([65, 66]));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("AB");
  });

  test("response passes through raw Response", () => {
    const raw = new Response("raw", { status: 209 });
    expect(ResponseEncoders.response().encode(raw)).toBe(raw);
  });

  test("mapInput adapts value before encoding", async () => {
    const encoder = ResponseEncoders.json<{ name: string }>(200).mapInput(
      (v: { petName: string }) => ({ name: v.petName }),
    );

    const response = encoder.encode({ petName: "Milo" });

    expect(await response.json()).toEqual({ name: "Milo" });
  });

  test("stream wraps ReadableStream with content type", async () => {
    const chunks = ["hello", " ", "world"];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });

    const response = ResponseEncoders.stream(200, "text/event-stream").encode(stream);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("hello world");
  });

  test("jsonWithHeaders extracts properties as HTTP headers", async () => {
    const encoder = ResponseEncoders.jsonWithHeaders<{
      rateLimit: number;
      requestId: string;
      data: string;
    }>(200, [
      ["rateLimit", "x-rate-limit"],
      ["requestId", "x-request-id"],
    ]);

    const response = encoder.encode({ rateLimit: 100, requestId: "abc", data: "hello" });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-rate-limit")).toBe("100");
    expect(response.headers.get("x-request-id")).toBe("abc");
    expect(response.headers.get("content-type")).toBe("application/json");

    const body = await response.json();
    expect(body).toEqual({ data: "hello" });
    expect(body).not.toHaveProperty("rateLimit");
    expect(body).not.toHaveProperty("requestId");
  });

  test("jsonWithHeaders skips undefined header values", async () => {
    const encoder = ResponseEncoders.jsonWithHeaders<{
      etag?: string;
      data: string;
    }>(200, [["etag", "etag"]]);

    const response = encoder.encode({ data: "hello" } as any);

    expect(response.headers.get("etag")).toBeNull();
    expect(await response.json()).toEqual({ data: "hello" });
  });

  test("jsonWithHeaders converts null header value to string", async () => {
    const encoder = ResponseEncoders.jsonWithHeaders<{
      tag: null;
      data: string;
    }>(200, [["tag", "x-tag"]]);

    const response = encoder.encode({ tag: null, data: "hello" });

    expect(response.headers.get("x-tag")).toBe("null");
  });

  test("jsonWithHeaders serializes array and object header values", () => {
    const encoder = ResponseEncoders.jsonWithHeaders<{
      tags: string[];
      filter: { role: string; active: boolean };
      data: string;
    }>(200, [
      ["tags", "x-tags"],
      ["filter", "x-filter", true],
    ]);

    const response = encoder.encode({
      tags: ["one", "two"],
      filter: { role: "admin", active: true },
      data: "ok",
    });

    expect(response.headers.get("x-tags")).toBe("one,two");
    expect(response.headers.get("x-filter")).toBe("role=admin,active=true");
  });

  test("jsonWithHeaders rejects non-plain structured header values", () => {
    class HeaderValue {
      readonly role = "admin";
    }

    const encoder = ResponseEncoders.jsonWithHeaders<{
      filter: unknown;
      data: string;
    }>(200, [["filter", "x-filter"]]);

    for (const filter of [new Date(0), new Map([["role", "admin"]]), new HeaderValue()]) {
      expect(() => encoder.encode({ filter, data: "ok" })).toThrow(
        "HTTP structured header values must be plain objects.",
      );
    }
  });

  test("jsonWithHeaders accepts null-prototype structured header records", () => {
    const filter = Object.assign(Object.create(null), { role: "admin", active: true });
    const encoder = ResponseEncoders.jsonWithHeaders<{
      filter: Record<string, unknown>;
      data: string;
    }>(200, [["filter", "x-filter", true]]);

    const response = encoder.encode({ filter, data: "ok" });

    expect(response.headers.get("x-filter")).toBe("role=admin,active=true");
  });

  test("jsonWithHeaders preserves multiple Set-Cookie values", () => {
    const encoder = ResponseEncoders.jsonWithHeaders<{
      cookies: string[];
      data: string;
    }>(200, [["cookies", "set-cookie"]]);

    const response = encoder.encode({
      cookies: ["session=abc; Path=/", "theme=dark; Path=/"],
      data: "ok",
    });

    expect(response.headers.getSetCookie()).toEqual(["session=abc; Path=/", "theme=dark; Path=/"]);
  });

  test("jsonWithHeaders encodes bytes as base64", () => {
    const encoder = ResponseEncoders.jsonWithHeaders<{
      digest: Uint8Array;
      data: string;
    }>(200, [["digest", "x-digest"]]);

    const response = encoder.encode({
      digest: new Uint8Array([1, 2, 255]),
      data: "ok",
    });

    expect(response.headers.get("x-digest")).toBe("AQL/");
  });

  test("variant extracts body and headers from response envelopes", async () => {
    const encoder = ResponseEncoders.variant<{
      requestId: string;
      body: string;
    }>({
      status: 201,
      kind: "text",
      contentType: "text/plain",
      headers: [["requestId", "x-request-id"]],
      body: "body",
      omit: ["requestId"],
    });

    const response = encoder.encode({ requestId: "req-1", body: "created" });

    expect(response.status).toBe(201);
    expect(response.headers.get("x-request-id")).toBe("req-1");
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(await response.text()).toBe("created");
  });

  test("JSON variant emits an empty body when an optional body is omitted", async () => {
    const response = ResponseEncoders.variant<{ body?: { value: bigint } }>({
      status: 200,
      kind: "json",
      body: "body",
      omit: ["body"],
    }).encode({});

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe("");
  });

  test("empty variants preserve declared response headers", async () => {
    const response = ResponseEncoders.variant<{ etag: string; cookies: string[] }>({
      status: 204,
      kind: "empty",
      headers: [
        ["etag", "etag"],
        ["cookies", "set-cookie"],
      ],
    }).encode({
      etag: '"revision-1"',
      cookies: ["session=abc; Path=/", "theme=dark; Path=/"],
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("etag")).toBe('"revision-1"');
    expect(response.headers.getSetCookie()).toEqual(["session=abc; Path=/", "theme=dark; Path=/"]);
    expect(await response.text()).toBe("");
  });

  test("variant omits metadata properties that are not in the handler type", async () => {
    const encoder = ResponseEncoders.variant<{ code: "NOT_FOUND"; message: string }>({
      status: 404,
      omit: ["_"],
    });

    const response = encoder.encode({ code: "NOT_FOUND", message: "missing" });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "NOT_FOUND", message: "missing" });
  });

  test("matchVariant dispatches to the first matching response encoder", async () => {
    type Result = { id: string; name: string } | { code: "NOT_FOUND"; message: string };

    const encoder = ResponseEncoders.matchVariant<Result>([
      {
        when: (value): value is Extract<Result, { id: string }> => "id" in value,
        encoder: ResponseEncoders.variant<Extract<Result, { id: string }>>({ status: 200 }),
      },
      {
        when: (value): value is Extract<Result, { code: "NOT_FOUND" }> => "code" in value,
        encoder: ResponseEncoders.variant<Extract<Result, { code: "NOT_FOUND" }>>({
          status: 404,
        }),
      },
    ]);

    const response = encoder.encode({ code: "NOT_FOUND", message: "missing" });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "NOT_FOUND", message: "missing" });
  });

  test("unreachable throws for unmatched generated branches", () => {
    expect(() => ResponseEncoders.unreachable({ code: "UNKNOWN" })).toThrow("did not match");
  });

  test("Content-Type headers match the selected encoder kind", () => {
    const json = ResponseEncoders.json<{ id: string }>(200).encode({ id: "p-1" });
    expect(json.headers.get("content-type")).toMatch(/^application\/json/);

    const text = ResponseEncoders.text(200).encode("hello");
    expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");

    const bytes = ResponseEncoders.bytes(200).encode(new Uint8Array([1, 2]));
    expect(bytes.headers.get("content-type")).toBe("application/octet-stream");
  });

  test("matchVariant dispatches same-status variants on body shape", async () => {
    type JsonFeed = { body: { id: string }[] };
    type CsvFeed = { body: string };
    type Result = JsonFeed | CsvFeed;

    const encoder = ResponseEncoders.matchVariant<Result>([
      {
        when: (v): v is JsonFeed => Array.isArray((v as Record<string, unknown>).body),
        encoder: ResponseEncoders.variant<JsonFeed>({
          status: 200,
          contentType: "application/json",
          body: "body",
          omit: ["body"],
        }),
      },
      {
        when: (v): v is CsvFeed => typeof (v as Record<string, unknown>).body === "string",
        encoder: ResponseEncoders.variant<CsvFeed>({
          status: 200,
          kind: "text",
          contentType: "text/csv",
          body: "body",
          omit: ["body"],
        }),
      },
    ]);

    const json = encoder.encode({ body: [{ id: "p-1" }] });
    expect(json.status).toBe(200);
    expect(json.headers.get("content-type")).toBe("application/json");
    expect(await json.json()).toEqual([{ id: "p-1" }]);

    const csv = encoder.encode({ body: "id\np-1\n" });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toBe("text/csv");
    expect(await csv.text()).toBe("id\np-1\n");
  });

  test("unsupported encoder throws with the configured reason when invoked", () => {
    const encoder = ResponseEncoders.unsupported<{ id: string }>(
      `Operation "list" declares unsupported response content type "application/xml".`,
    );
    expect(() => encoder.encode({ id: "p-1" })).toThrow("application/xml");
  });

  test("variant encoder sets Content-Type from declared kind when not overridden", () => {
    const text = ResponseEncoders.variant<{ body: string }>({
      status: 200,
      kind: "text",
      body: "body",
    }).encode({ body: "hi" });
    expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");

    const bytes = ResponseEncoders.variant<{ body: Uint8Array }>({
      status: 200,
      kind: "bytes",
      body: "body",
    }).encode({ body: new Uint8Array([42]) });
    expect(bytes.headers.get("content-type")).toBe("application/octet-stream");
  });

  test("variant encoder preserves an explicit Content-Type and defaults when absent", () => {
    const encoder = ResponseEncoders.variant<{ contentType?: string; body: string }>({
      status: 200,
      kind: "text",
      headers: [["contentType", "content-type"]],
      body: "body",
    });

    const explicit = encoder.encode({ contentType: "text/csv", body: "id\np-1\n" });
    expect(explicit.headers.get("content-type")).toBe("text/csv");

    const defaulted = encoder.encode({ body: "plain text" });
    expect(defaulted.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });
});
