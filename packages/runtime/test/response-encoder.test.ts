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
    const encoder = ResponseEncoders
      .json<{ name: string }>(200)
      .mapInput((v: { petName: string }) => ({ name: v.petName }));

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
    type Result =
      | { id: string; name: string }
      | { code: "NOT_FOUND"; message: string };

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
    expect(() => ResponseEncoders.unreachable({ code: "UNKNOWN" })).toThrow(
      "did not match",
    );
  });

  test("Content-Type headers match the selected encoder kind", () => {
    const json = ResponseEncoders.json<{ id: string }>(200).encode({ id: "p-1" });
    expect(json.headers.get("content-type")).toMatch(/^application\/json/);

    const text = ResponseEncoders.text(200).encode("hello");
    expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");

    const bytes = ResponseEncoders.bytes(200).encode(new Uint8Array([1, 2]));
    expect(bytes.headers.get("content-type")).toBe("application/octet-stream");
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
});
