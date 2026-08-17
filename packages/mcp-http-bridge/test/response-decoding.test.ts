import { describe, expect, test } from "bun:test";
import { McpToolError } from "@typespex/mcp-server";
import { decodeBase64, responseFileName } from "../src/binary.js";
import type { HttpBridgeResponse } from "../src/contracts.js";
import { decodeHttpBridgeResponse } from "../src/response.js";

const signal = new AbortController().signal;

async function decode(response: Response, descriptor: HttpBridgeResponse): Promise<unknown> {
  return decodeHttpBridgeResponse(response, descriptor, {}, signal);
}

describe("HTTP bridge response decoding", () => {
  test("infers JSONL, form, text, binary, and file response representations", async () => {
    await expect(
      decode(
        new Response('{"id":1}\n{"id":2}\n', {
          headers: { "Content-Type": "application/x-ndjson" },
        }),
        { statuses: [200] },
      ),
    ).resolves.toEqual([{ id: 1 }, { id: 2 }]);

    await expect(
      decode(
        new Response("tag=one&tag=two&name=Rex", {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }),
        { statuses: [200] },
      ),
    ).resolves.toEqual({ tag: ["one", "two"], name: "Rex" });

    await expect(
      decode(new Response("hello", { headers: { "Content-Type": "text/plain" } }), {
        statuses: [200],
      }),
    ).resolves.toBe("hello");

    await expect(
      decode(
        new Response(new Uint8Array([0, 1, 2]), {
          headers: { "Content-Type": "application/octet-stream" },
        }),
        { statuses: [200] },
      ),
    ).resolves.toBe("AAEC");

    await expect(
      decode(
        new Response(new Uint8Array([65]), {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": "attachment; filename*=UTF-8''report%20one.pdf",
          },
        }),
        { statuses: [200], kind: "file" },
      ),
    ).resolves.toEqual({
      name: "report one.pdf",
      mediaType: "application/pdf",
      data: "QQ==",
    });
  });

  test("decodes generic multipart fields and files", async () => {
    const boundary = "typespex-response-test";
    const body = [
      `--${boundary}\r\nContent-Disposition: form-data; name="tag"\r\n\r\none\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="tag"\r\n\r\ntwo\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n`,
      `--${boundary}--\r\n`,
    ].join("");

    await expect(
      decode(
        new Response(body, {
          headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
        }),
        { statuses: [200], kind: "multipart" },
      ),
    ).resolves.toEqual({
      tag: ["one", "two"],
      attachment: {
        name: "note.txt",
        mediaType: "text/plain;charset=utf-8",
        data: "aGVsbG8=",
      },
    });
  });

  test("rejects malformed JSON and base64 while handling filename variants", async () => {
    await expect(
      decode(new Response("{", { headers: { "Content-Type": "application/json" } }), {
        statuses: [200],
      }),
    ).rejects.toBeInstanceOf(McpToolError);
    expect(() => decodeBase64("not base64")).toThrow(McpToolError);
    expect(responseFileName(null)).toBeUndefined();
    expect(responseFileName('attachment; filename="plain.txt"')).toBe("plain.txt");
    expect(responseFileName("attachment; filename=plain.txt")).toBe("plain.txt");
    expect(responseFileName("attachment; filename*=UTF-8''%zz")).toBeUndefined();
  });

  test("reconstructs a declared content-type target", async () => {
    await expect(
      decode(Response.json({ ok: true }), {
        statuses: [200],
        kind: "json",
        bodyTarget: ["body"],
        contentTypeTarget: ["contentType"],
      }),
    ).resolves.toEqual({
      body: { ok: true },
      contentType: "application/json",
    });
  });
});
