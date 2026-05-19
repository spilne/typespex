import { describe, expect, test } from "bun:test";
import { ResponseEncoders, ErrorEncoders } from "../src/server.js";

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

  test("discriminated dispatches success responses by status field", async () => {
    const encoder = ResponseEncoders.discriminated<
      { _: 201; id: string } | { _: 202; operationId: string }
    >(
      "_",
      {
        "201": { status: 201, omit: ["_"] },
        "202": { status: 202, omit: ["_"] },
      },
      { status: 200, omit: ["_"] },
    );

    const created = encoder.encode({ _: 201, id: "item-1" });
    const accepted = encoder.encode({ _: 202, operationId: "op-1" });

    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: "item-1" });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ operationId: "op-1" });
  });
});

// ---------------------------------------------------------------------------
// ErrorEncoders
// ---------------------------------------------------------------------------

describe("ErrorEncoders", () => {
  test("json encodes error with fixed status", async () => {
    const encoder = ErrorEncoders.json<{ message: string }>(422);
    const response = encoder.encode({ message: "invalid" });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ message: "invalid" });
  });

  test("discriminated dispatches by string tag", async () => {
    type E = { code: "NOT_FOUND"; message: string } | { code: "FORBIDDEN"; message: string };

    const encoder = ErrorEncoders.discriminated<E>("code", {
      NOT_FOUND: 404,
      FORBIDDEN: 403,
    });

    const notFound = encoder.encode({ code: "NOT_FOUND", message: "gone" });
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ code: "NOT_FOUND", message: "gone" });

    const forbidden = encoder.encode({ code: "FORBIDDEN", message: "nope" });
    expect(forbidden.status).toBe(403);
  });

  test("discriminated dispatches by numeric tag", async () => {
    const encoder = ErrorEncoders.discriminated<{ status: number }>("status", {
      "404": 404,
      "409": 409,
    });

    const response = encoder.encode({ status: 404 });
    expect(response.status).toBe(404);
  });

  test("discriminated uses fallback for unknown tag", async () => {
    const encoder = ErrorEncoders.discriminated<{ code: string }>("code", {
      KNOWN: 400,
    }, 500);

    const response = encoder.encode({ code: "UNKNOWN" });
    expect(response.status).toBe(500);
  });

  test("discriminated uses fallback when tag field is missing", async () => {
    const encoder = ErrorEncoders.discriminated<Record<string, unknown>>("code", {
      KNOWN: 400,
    }, 500);

    const response = encoder.encode({ message: "no code field" });
    expect(response.status).toBe(500);
  });

  test("byProperty dispatches by unique property existence", async () => {
    type E = { retryAfter: number } | { conflictId: string };

    const encoder = ErrorEncoders.byProperty<E>({
      retryAfter: 429,
      conflictId: 409,
    });

    const retry = encoder.encode({ retryAfter: 30 });
    expect(retry.status).toBe(429);
    expect(await retry.json()).toEqual({ retryAfter: 30 });

    const conflict = encoder.encode({ conflictId: "abc" });
    expect(conflict.status).toBe(409);
  });

  test("byProperty uses fallback when no property matches", async () => {
    const encoder = ErrorEncoders.byProperty<{ message: string }>({
      retryAfter: 429,
    }, 500);

    const response = encoder.encode({ message: "unknown" });
    expect(response.status).toBe(500);
  });

  test("byProperty checks first matching property", async () => {
    const encoder = ErrorEncoders.byProperty<{ a: number; b: number }>({
      a: 400,
      b: 401,
    });

    // Both properties present — first one wins
    const response = encoder.encode({ a: 1, b: 2 });
    expect(response.status).toBe(400);
  });
});
