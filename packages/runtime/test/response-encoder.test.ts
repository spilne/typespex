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

  test("oneOf dispatches responses by status field", async () => {
    const encoder = ResponseEncoders.oneOf<
      { _: 201; id: string } | { _: 202; operationId: string }
    >([
      {
        kind: "field",
        field: "_",
        cases: {
          "201": { status: 201, omit: ["_"] },
          "202": { status: 202, omit: ["_"] },
        },
      },
    ]);

    const created = encoder.encode({ _: 201, id: "item-1" });
    const accepted = encoder.encode({ _: 202, operationId: "op-1" });

    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: "item-1" });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ operationId: "op-1" });
  });

  test("oneOf dispatches responses by string tag", async () => {
    type E = { code: "NOT_FOUND"; message: string } | { code: "FORBIDDEN"; message: string };

    const encoder = ResponseEncoders.oneOf<E>([{
      kind: "field",
      field: "code",
      cases: {
        NOT_FOUND: { status: 404 },
        FORBIDDEN: { status: 403 },
      },
    }]);

    const notFound = encoder.encode({ code: "NOT_FOUND", message: "gone" });
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ code: "NOT_FOUND", message: "gone" });

    const forbidden = encoder.encode({ code: "FORBIDDEN", message: "nope" });
    expect(forbidden.status).toBe(403);
  });

  test("oneOf dispatches by numeric tag", async () => {
    const encoder = ResponseEncoders.oneOf<{ status: number }>([{
      kind: "field",
      field: "status",
      cases: {
        "404": { status: 404 },
        "409": { status: 409 },
      },
    }]);

    const response = encoder.encode({ status: 404 });
    expect(response.status).toBe(404);
  });

  test("oneOf throws when no variant matches", () => {
    const encoder = ResponseEncoders.oneOf<{ code: string }>([{
      kind: "field",
      field: "code",
      cases: {
        KNOWN: { status: 400 },
      },
    }]);

    expect(() => encoder.encode({ code: "UNKNOWN" })).toThrow("did not match");
  });

  test("oneOf dispatches by unique property existence", async () => {
    type E = { retryAfter: number } | { conflictId: string };

    const encoder = ResponseEncoders.oneOf<E>([{
      kind: "property",
      cases: {
        retryAfter: { status: 429 },
        conflictId: { status: 409 },
      },
    }]);

    const retry = encoder.encode({ retryAfter: 30 });
    expect(retry.status).toBe(429);
    expect(await retry.json()).toEqual({ retryAfter: 30 });

    const conflict = encoder.encode({ conflictId: "abc" });
    expect(conflict.status).toBe(409);
  });

  test("oneOf checks first matching property", async () => {
    const encoder = ResponseEncoders.oneOf<{ a: number; b: number }>([{
      kind: "property",
      cases: {
        a: { status: 400 },
        b: { status: 401 },
      },
    }]);

    const response = encoder.encode({ a: 1, b: 2 });
    expect(response.status).toBe(400);
  });

  test("oneOf dispatches void and object variants", async () => {
    const encoder = ResponseEncoders.oneOf<void | { code: "NOT_FOUND"; message: string }>([
      { kind: "undefined", variant: { status: 204, kind: "empty" } },
      { kind: "object", variant: { status: 404 } },
    ]);

    const empty = encoder.encode(undefined);
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");

    const error = encoder.encode({ code: "NOT_FOUND", message: "missing" });
    expect(error.status).toBe(404);
    expect(await error.json()).toEqual({ code: "NOT_FOUND", message: "missing" });
  });
});
