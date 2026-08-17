import { describe, expect, test } from "bun:test";
import { Decoders, Either, ValidationError, decodeBody } from "../src/server.js";

interface RawPart {
  readonly headers?: readonly string[];
  readonly body?: string | Uint8Array;
}

const encoder = new TextEncoder();

function multipartRequest(
  mediaType: string,
  boundary: string,
  parts: readonly RawPart[],
  options: {
    readonly close?: boolean;
    readonly quotedBoundary?: boolean;
    readonly preamble?: string;
    readonly epilogue?: string;
    readonly transportPadding?: string;
  } = {},
): Request {
  const chunks: Uint8Array[] = [];
  if (options.preamble !== undefined) {
    chunks.push(encoder.encode(`${options.preamble}\r\n`));
  }
  for (const part of parts) {
    chunks.push(encoder.encode(`--${boundary}${options.transportPadding ?? ""}\r\n`));
    for (const header of part.headers ?? []) chunks.push(encoder.encode(`${header}\r\n`));
    chunks.push(encoder.encode("\r\n"));
    chunks.push(
      typeof part.body === "string" ? encoder.encode(part.body) : (part.body ?? new Uint8Array()),
    );
    chunks.push(encoder.encode("\r\n"));
  }
  if (options.close !== false) {
    chunks.push(
      encoder.encode(
        `--${boundary}--${options.transportPadding ?? ""}\r\n${options.epilogue ?? ""}`,
      ),
    );
  }

  return new Request("http://localhost/upload", {
    method: "POST",
    headers: {
      "content-type": `${mediaType}; boundary=${
        options.quotedBoundary ? JSON.stringify(boundary) : boundary
      }`,
    },
    body: concat(chunks),
  });
}

function concat(chunks: readonly Uint8Array[]): ArrayBuffer {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new ArrayBuffer(length);
  const view = new Uint8Array(result);
  let offset = 0;
  for (const chunk of chunks) {
    view.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function issueMessages(result: Awaited<ReturnType<typeof decodeBody>>): string[] {
  expect(result._tag).toBe("Left");
  if (result._tag === "Right") return [];
  expect(result.left).toBeInstanceOf(ValidationError);
  return (result.left as ValidationError).issues.map((issue) => `${issue.path}: ${issue.message}`);
}

describe("schema-aware multipart decoding", () => {
  test("decodes ordered unnamed multipart/mixed text and canonical File parts", async () => {
    const result = await decodeBody(
      multipartRequest(
        "multipart/mixed",
        "quoted boundary",
        [
          {
            headers: ["Content-Type: text/plain; charset=utf-8"],
            body: "hello",
          },
          {
            headers: ["Content-Type: application/octet-stream"],
            body: new Uint8Array([0, 255, 13, 10, 1]),
          },
        ],
        { quotedBoundary: true },
      ),
      {
        multipart: Decoders.multipartTuple<[string, File]>([
          {
            kind: "text",
            decoder: Decoders.string,
            contentTypes: ["text/plain"],
            requireContentType: true,
          },
          {
            kind: "file",
            decoder: Decoders.file,
            contentTypes: ["application/octet-stream"],
          },
        ]),
      },
      { contentTypes: ["multipart/mixed"] },
    );

    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right[0]).toBe("hello");
      expect(result.right[1]).toBeInstanceOf(File);
      expect(result.right[1].name).toBe("");
      expect(result.right[1].type).toBe("application/octet-stream");
      expect(new Uint8Array(await result.right[1].arrayBuffer())).toEqual(
        new Uint8Array([0, 255, 13, 10, 1]),
      );
    }
  });

  test("decodes named text, binary, JSON, optional, and repeated form-data parts", async () => {
    type Input = {
      count: number;
      bytes: Uint8Array;
      metadata: { id: bigint };
      tags: string[];
      note?: string;
    };
    const result = await decodeBody(
      multipartRequest("multipart/form-data", "fields", [
        {
          headers: ['Content-Disposition: form-data; name="count"', "Content-Type: text/plain"],
          body: "42",
        },
        {
          headers: [
            'Content-Disposition: form-data; name="bytes"',
            "Content-Type: application/octet-stream",
          ],
          body: new Uint8Array([0, 255, 128]),
        },
        {
          headers: [
            'Content-Disposition: form-data; name="metadata"',
            "Content-Type: application/json",
          ],
          body: '{"id":18446744073709551615}',
        },
        {
          headers: ['Content-Disposition: form-data; name="tag"'],
          body: "one",
        },
        {
          headers: ['Content-Disposition: form-data; name="tag"'],
          body: "two",
        },
      ]),
      {
        multipart: Decoders.multipartFormData<Input>([
          {
            name: "count",
            property: "count",
            kind: "text",
            decoder: Decoders.integer,
            contentTypes: ["text/plain"],
          },
          {
            name: "bytes",
            property: "bytes",
            kind: "binary",
            decoder: Decoders.bytes,
            contentTypes: ["application/octet-stream"],
          },
          {
            name: "metadata",
            property: "metadata",
            kind: "json",
            decoder: Decoders.object({ id: Decoders.strictBigint }),
            contentTypes: ["application/json"],
          },
          {
            name: "tag",
            property: "tags",
            kind: "text",
            decoder: Decoders.string,
            multi: true,
          },
          {
            name: "note",
            property: "note",
            kind: "text",
            decoder: Decoders.string,
            optional: true,
          },
        ]),
      },
      { contentTypes: ["multipart/form-data"] },
    );

    expect(result).toEqual(
      Either.right({
        count: 42,
        bytes: new Uint8Array([0, 255, 128]),
        metadata: { id: 18446744073709551615n },
        tags: ["one", "two"],
      }),
    );
  });

  test("decodes one JSON array part without treating it as repeated parts", async () => {
    const result = await decodeBody(
      multipartRequest("multipart/form-data", "json-array", [
        {
          headers: [
            'Content-Disposition: form-data; name="values"',
            "Content-Type: application/json",
          ],
          body: '["one","two"]',
        },
      ]),
      {
        multipart: Decoders.multipartFormData<{ values: string[] }>([
          {
            name: "values",
            property: "values",
            kind: "json",
            decoder: Decoders.strictArray(Decoders.string),
            contentTypes: ["application/json"],
          },
        ]),
      },
      { contentTypes: ["multipart/form-data"] },
    );

    expect(result).toEqual(Either.right({ values: ["one", "two"] }));
  });

  test("uses a relocated per-part header for File.name and ignores disposition filename", async () => {
    const result = await decodeBody(
      multipartRequest("multipart/form-data", "file", [
        {
          headers: [
            'Content-Disposition: form-data; name="data"; filename="../ignored.txt"',
            "Content-Type: image/png",
            "X-File-Name: safe.png",
          ],
          body: new Uint8Array([1, 2, 3]),
        },
      ]),
      {
        multipart: Decoders.multipartFormData<{ file: File }>([
          {
            name: "data",
            property: "file",
            kind: "file",
            decoder: Decoders.file,
            contentTypes: ["image/*"],
            fileNameHeader: "x-file-name",
            requireFileName: true,
          },
        ]),
      },
      { contentTypes: ["multipart/form-data"] },
    );

    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right.file.name).toBe("safe.png");
      expect(result.right.file.type).toBe("image/png");
    }
  });

  test("rejects absent relocated filenames and unsafe selected filenames", async () => {
    const decoder = Decoders.multipartFormData<{ file: File }>([
      {
        name: "data",
        property: "file",
        kind: "file",
        decoder: Decoders.file,
        fileNameHeader: "x-file-name",
        requireFileName: true,
      },
    ]);

    const missing = await decodeBody(
      multipartRequest("multipart/form-data", "missing-name", [
        {
          headers: ['Content-Disposition: form-data; name="data"'],
          body: "bytes",
        },
      ]),
      { multipart: decoder },
      { contentTypes: ["multipart/form-data"] },
    );
    expect(issueMessages(missing).join("\n")).toContain('missing its "x-file-name"');

    const unsafe = await decodeBody(
      multipartRequest("multipart/form-data", "unsafe-name", [
        {
          headers: ['Content-Disposition: form-data; name="data"', "X-File-Name: ../secret.txt"],
          body: "bytes",
        },
      ]),
      { multipart: decoder },
      { contentTypes: ["multipart/form-data"] },
    );
    expect(issueMessages(unsafe).join("\n")).toContain("must not contain path components");
  });

  test("dispatches a legal mixed JSON/text part contract by received content type", async () => {
    const descriptor = {
      decoders: {
        json: Decoders.strictBigint,
        text: Decoders.bigint,
      },
      contentTypes: ["application/json", "text/plain"],
    } as const;

    const json = await decodeBody(
      multipartRequest("multipart/mixed", "json", [
        { headers: ["Content-Type: application/json"], body: "18446744073709551615" },
      ]),
      {
        multipart: Decoders.multipartTuple<[bigint]>([descriptor]),
      },
      { contentTypes: ["multipart/mixed"] },
    );
    expect(json).toEqual(Either.right([18446744073709551615n]));

    const text = await decodeBody(
      multipartRequest("multipart/mixed", "text", [
        { headers: ["Content-Type: text/plain"], body: "42" },
      ]),
      {
        multipart: Decoders.multipartTuple<[bigint]>([descriptor]),
      },
      { contentTypes: ["multipart/mixed"] },
    );
    expect(text).toEqual(Either.right([42n]));

    const defaultText = await decodeBody(
      multipartRequest("multipart/mixed", "default-text", [{ body: "7" }]),
      {
        multipart: Decoders.multipartTuple<[bigint]>([descriptor]),
      },
      { contentTypes: ["multipart/mixed"] },
    );
    expect(defaultText).toEqual(Either.right([7n]));
  });

  test("maps optional and repeated ordered parts only when cardinality is unambiguous", async () => {
    const decoder = Decoders.multipartTuple<[string[] | undefined, File]>([
      {
        kind: "text",
        decoder: Decoders.string,
        multi: true,
        optional: true,
      },
      {
        kind: "file",
        decoder: Decoders.file,
      },
    ]);
    const result = await decodeBody(
      multipartRequest("multipart/mixed", "repeat", [
        { body: "one" },
        { body: "two" },
        { headers: ["Content-Type: application/octet-stream"], body: new Uint8Array([3]) },
      ]),
      { multipart: decoder },
      { contentTypes: ["multipart/mixed"] },
    );
    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right[0]).toEqual(["one", "two"]);
      expect(await result.right[1].arrayBuffer()).toHaveLength(1);
    }

    const omittedRepeated = await decodeBody(
      multipartRequest("multipart/mixed", "omitted-repeat", [
        { headers: ["Content-Type: application/octet-stream"], body: new Uint8Array([4]) },
      ]),
      { multipart: decoder },
      { contentTypes: ["multipart/mixed"] },
    );
    expect(omittedRepeated._tag).toBe("Right");
    if (omittedRepeated._tag === "Right") {
      expect(omittedRepeated.right[0]).toBeUndefined();
      expect(new Uint8Array(await omittedRepeated.right[1].arrayBuffer())).toEqual(
        new Uint8Array([4]),
      );
    }

    const ambiguous = await decodeBody(
      multipartRequest("multipart/mixed", "ambiguous", [{ body: "one" }]),
      {
        multipart: Decoders.multipartTuple<[string | undefined, string | undefined]>([
          { kind: "text", decoder: Decoders.string, optional: true },
          { kind: "text", decoder: Decoders.string, optional: true },
        ]),
      },
      { contentTypes: ["multipart/mixed"] },
    );
    expect(issueMessages(ambiguous).join("\n")).toContain("cardinality is ambiguous");
  });

  test("validates names for positional multipart/form-data tuples", async () => {
    const result = await decodeBody(
      multipartRequest("multipart/form-data", "named-tuple", [
        {
          headers: ['Content-Disposition: form-data; name="first"'],
          body: "one",
        },
        {
          headers: ['Content-Disposition: form-data; name="second"'],
          body: "two",
        },
      ]),
      {
        multipart: Decoders.multipartTuple<[string, string]>([
          { name: "first", kind: "text", decoder: Decoders.string },
          { name: "second", kind: "text", decoder: Decoders.string },
        ]),
      },
      { contentTypes: ["multipart/form-data"] },
    );
    expect(result).toEqual(Either.right(["one", "two"]));
  });

  test("resolves adjacent repeated groups from wire media evidence", async () => {
    const result = await decodeBody(
      multipartRequest("multipart/mixed", "repeated-groups", [
        { headers: ["Content-Type: text/plain"], body: "one" },
        { headers: ["Content-Type: text/plain"], body: "two" },
        {
          headers: ["Content-Type: application/octet-stream"],
          body: new Uint8Array([1]),
        },
        {
          headers: ["Content-Type: application/octet-stream"],
          body: new Uint8Array([2]),
        },
      ]),
      {
        multipart: Decoders.multipartTuple<[string[], Uint8Array[]]>([
          {
            kind: "text",
            decoder: Decoders.string,
            contentTypes: ["text/plain"],
            multi: true,
          },
          {
            kind: "binary",
            decoder: Decoders.bytes,
            contentTypes: ["application/octet-stream"],
            multi: true,
          },
        ]),
      },
      { contentTypes: ["multipart/mixed"] },
    );

    expect(result).toEqual(
      Either.right([
        ["one", "two"],
        [new Uint8Array([1]), new Uint8Array([2])],
      ]),
    );
  });

  test("maps a named model carried by multipart/mixed", async () => {
    const result = await decodeBody(
      multipartRequest("multipart/mixed", "named-mixed", [
        {
          headers: [
            'Content-Disposition: attachment; name="wire-source"',
            "Content-Type: text/plain",
          ],
          body: "source",
        },
        {
          headers: [
            'Content-Disposition: attachment; name="wire-file"',
            "Content-Type: application/octet-stream",
          ],
          body: new Uint8Array([4, 5]),
        },
      ]),
      {
        multipart: Decoders.multipartFormData<{ source: string; file: File }>([
          {
            name: "wire-source",
            property: "source",
            kind: "text",
            decoder: Decoders.string,
          },
          {
            name: "wire-file",
            property: "file",
            kind: "file",
            decoder: Decoders.file,
          },
        ]),
      },
      { contentTypes: ["multipart/mixed"] },
    );

    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right.source).toBe("source");
      expect(result.right.file.name).toBe("");
      expect(new Uint8Array(await result.right.file.arrayBuffer())).toEqual(new Uint8Array([4, 5]));
    }
  });

  test("preserves empty parts and rejects missing, extra, or repeated single parts", async () => {
    const tuple = Decoders.multipartTuple<[string]>([{ kind: "text", decoder: Decoders.string }]);
    const empty = await decodeBody(
      multipartRequest("multipart/mixed", "empty", [{ body: "" }]),
      { multipart: tuple },
      { contentTypes: ["multipart/mixed"] },
    );
    expect(empty).toEqual(Either.right([""]));

    const missing = await decodeBody(
      multipartRequest("multipart/mixed", "missing", []),
      { multipart: tuple },
      { contentTypes: ["multipart/mixed"] },
    );
    expect(issueMessages(missing).join("\n")).toContain("Expected at least 1");

    const extra = await decodeBody(
      multipartRequest("multipart/mixed", "extra", [{ body: "a" }, { body: "b" }]),
      { multipart: tuple },
      { contentTypes: ["multipart/mixed"] },
    );
    expect(issueMessages(extra).join("\n")).toContain("Expected at most 1");

    const repeatedNamed = await decodeBody(
      multipartRequest("multipart/form-data", "repeated", [
        { headers: ['Content-Disposition: form-data; name="one"'], body: "a" },
        { headers: ['Content-Disposition: form-data; name="one"'], body: "b" },
      ]),
      {
        multipart: Decoders.multipartFormData<{ one: string }>([
          {
            name: "one",
            property: "one",
            kind: "text",
            decoder: Decoders.string,
          },
        ]),
      },
      { contentTypes: ["multipart/form-data"] },
    );
    expect(issueMessages(repeatedNamed).join("\n")).toContain("must occur at most once");
  });

  test("validates per-part content types before decoding", async () => {
    const result = await decodeBody(
      multipartRequest("multipart/mixed", "wrong-type", [
        { headers: ["Content-Type: text/plain"], body: "not png" },
      ]),
      {
        multipart: Decoders.multipartTuple<[File]>([
          {
            kind: "file",
            decoder: Decoders.file,
            contentTypes: ["image/png"],
            requireContentType: true,
          },
        ]),
      },
      { contentTypes: ["multipart/mixed"] },
    );
    expect(issueMessages(result).join("\n")).toContain("outside its declared contract");
  });

  test("rejects decoder maps without a usable decoder", async () => {
    const result = await decodeBody(
      multipartRequest("multipart/mixed", "missing-decoder", [{ body: "value" }]),
      {
        multipart: Decoders.multipartTuple<[string]>([
          {
            decoders: { text: undefined },
          },
        ]),
      },
      { contentTypes: ["multipart/mixed"] },
    );

    expect(issueMessages(result).join("\n")).toContain("Multipart part has no decoder");
  });

  test("rejects malformed boundary, delimiter, headers, and unknown named fields", async () => {
    const tuple = Decoders.multipartTuple<[string]>([{ kind: "text", decoder: Decoders.string }]);
    const missingBoundary = new Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-type": "multipart/mixed" },
      body: "anything",
    });
    expect(
      issueMessages(
        await decodeBody(
          missingBoundary,
          { multipart: tuple },
          { contentTypes: ["multipart/mixed"] },
        ),
      ).join("\n"),
    ).toContain("missing its boundary");

    const unclosed = await decodeBody(
      multipartRequest("multipart/mixed", "unclosed", [{ body: "value" }], {
        close: false,
      }),
      { multipart: tuple },
      { contentTypes: ["multipart/mixed"] },
    );
    expect(issueMessages(unclosed).join("\n")).toContain("missing its closing boundary");

    for (const headers of [
      ["Malformed"],
      [" Folded: no"],
      ["X-Test: one", "X-Test: two"],
      ["Content-Type: text/plain; broken"],
    ]) {
      const malformed = await decodeBody(
        multipartRequest("multipart/mixed", "bad-header", [{ headers, body: "value" }]),
        { multipart: tuple },
        { contentTypes: ["multipart/mixed"] },
      );
      expect(issueMessages(malformed).length).toBeGreaterThan(0);
    }

    const unknown = await decodeBody(
      multipartRequest("multipart/form-data", "unknown", [
        { headers: ['Content-Disposition: form-data; name="other"'], body: "value" },
      ]),
      {
        multipart: Decoders.multipartFormData<{ known?: string }>([
          {
            name: "known",
            property: "known",
            kind: "text",
            decoder: Decoders.string,
            optional: true,
          },
        ]),
      },
      { contentTypes: ["multipart/form-data"] },
    );
    expect(issueMessages(unknown).join("\n")).toContain("Unexpected multipart part");
  });

  test("enforces conservative multipart boundary, header, and part-count limits", async () => {
    const tuple = Decoders.multipartTuple<[string[]]>([
      {
        kind: "text",
        decoder: Decoders.string,
        optional: true,
        multi: true,
      },
    ]);
    const tooLongBoundary = "b".repeat(71);
    const boundaryResult = await decodeBody(
      multipartRequest("multipart/mixed", tooLongBoundary, []),
      { multipart: tuple },
      { contentTypes: ["multipart/mixed"] },
    );
    expect(issueMessages(boundaryResult).join("\n")).toContain("boundary is invalid");

    const headerResult = await decodeBody(
      multipartRequest("multipart/mixed", "large-header", [
        { headers: [`X-Large: ${"a".repeat(16 * 1024)}`], body: "value" },
      ]),
      { multipart: tuple },
      { contentTypes: ["multipart/mixed"] },
    );
    expect(issueMessages(headerResult).join("\n")).toContain("headers are missing or too large");

    const partResult = await decodeBody(
      multipartRequest(
        "multipart/mixed",
        "many-parts",
        Array.from({ length: 257 }, () => ({ body: "" })),
      ),
      { multipart: tuple },
      { contentTypes: ["multipart/mixed"] },
    );
    expect(issueMessages(partResult).join("\n")).toContain("256-part limit");
  });

  test("accepts MIME preamble, delimiter transport padding, and arbitrary epilogue", async () => {
    const result = await decodeBody(
      multipartRequest(
        "multipart/mixed",
        "mime-grammar",
        [{ headers: ["Content-Type: text/plain"], body: "value" }],
        {
          preamble: "This text is a legal MIME preamble.",
          epilogue: "This epilogue is not restricted to whitespace.",
          transportPadding: " \t",
        },
      ),
      {
        multipart: Decoders.multipartTuple<[string]>([
          {
            kind: "text",
            decoder: Decoders.string,
            contentTypes: ["text/plain"],
          },
        ]),
      },
      { contentTypes: ["multipart/mixed"] },
    );

    expect(result).toEqual(Either.right(["value"]));
  });
});
