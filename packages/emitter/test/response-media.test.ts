import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildEmitter,
  cleanupFixtures,
  compileFixture,
  compileFixtureExpectingDiagnostics,
} from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const validResponseMediaSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "ResponseMediaApi" })
namespace ResponseMediaApi;

model Payload {
  ok: boolean;
}

model UpperJson {
  @header contentType: "Application/JSON; Charset=utf-8";
  @body body: Payload;
}

model VendorJson {
  @header contentType: "application/problem+json; charset=utf-8";
  @body body: Payload;
}

model TextNumber {
  @header contentType: "Text/Plain; Charset=utf-8";
  @body body: int32;
}

model BinaryBytes {
  @header contentType: "Application/Octet-Stream";
  @body body: bytes;
}

model ImageBytes {
  @header contentType: "Image/PNG; Profile=raw";
  @body body: bytes;
}

model JsonBytes {
  @header contentType: "application/json";
  @body body: bytes;
}

@route("/upper-json")
@get
op upperJson(): UpperJson;

@route("/vendor-json")
@get
op vendorJson(): VendorJson;

@route("/text-number")
@get
op textNumber(): TextNumber;

@route("/binary")
@get
op binary(): BinaryBytes;

@route("/image")
@get
op image(): ImageBytes;

@route("/json-bytes")
@get
op jsonBytes(): JsonBytes;
`;

const invalidResponseMediaSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "InvalidResponseMediaApi" })
namespace InvalidResponseMediaApi;

model Payload {
  ok: boolean;
}

model FalseJson {
  @header contentType: "application/notjson";
  @body body: Payload;
}

model Jsonp {
  @header contentType: "application/jsonp";
  @body body: Payload;
}

model EmptyStructuredSuffix {
  @header contentType: "application/+json";
  @body body: Payload;
}

model ModelAsText {
  @header contentType: "text/plain";
  @body body: Payload;
}

model StringAsBytes {
  @header contentType: "application/octet-stream";
  @body body: string;
}

model BytesAsText {
  @header contentType: "text/plain";
  @body body: bytes;
}

model StringAsImage {
  @header contentType: "image/png";
  @body body: string;
}

model BytesWithMalformedMediaType {
  @header contentType: "not-a-media-type";
  @body body: bytes;
}

model MultipartResponse {
  @multipartBody fields: {
    files: HttpPart<File>[];
  };
}

@route("/false-json")
@get
op falseJson(): FalseJson;

@route("/jsonp")
@get
op jsonp(): Jsonp;

@route("/empty-structured-suffix")
@get
op emptyStructuredSuffix(): EmptyStructuredSuffix;

@route("/model-text")
@get
op modelText(): ModelAsText;

@route("/string-bytes")
@get
op stringBytes(): StringAsBytes;

@route("/bytes-text")
@get
op bytesText(): BytesAsText;

@route("/string-image")
@get
op stringImage(): StringAsImage;

@route("/bytes-malformed-media-type")
@get
op bytesMalformedMediaType(): BytesWithMalformedMediaType;

@route("/multipart")
@get
op multipart(): MultipartResponse;
`;

describe("response media classification", () => {
  test("normalizes exact media types and emits compatible wire encoders", async () => {
    const result = compileFixture("response-media-valid", validResponseMediaSpec);
    const operations = result.readFile("response-media-api", "server-operations.ts");

    expect(operations).toContain(`contentType: "Application/JSON; Charset=utf-8"`);
    expect(operations).toContain(`contentType: "application/problem+json; charset=utf-8"`);
    expect(operations).toContain(`contentType: "Text/Plain; Charset=utf-8"`);
    expect(operations).toContain(`contentType: "Application/Octet-Stream"`);
    expect(operations).toContain(`contentType: "Image/PNG; Profile=raw"`);
    expect(operations).toContain(`kind: "text"`);
    expect(operations).toContain(`kind: "bytes"`);
    result.typecheck("response-media-api");

    const { createResponseMediaApiServerRouter } = await import(
      `${result.outputDir}/response-media-api/server-router.ts`
    );
    const router = createResponseMediaApiServerRouter({
      upperJson: () => ({ body: { ok: true } }),
      vendorJson: () => ({ body: { ok: false } }),
      textNumber: () => ({ body: 42 }),
      binary: () => ({ body: new Uint8Array([65, 66]) }),
      image: () => ({ body: new Uint8Array([137, 80, 78, 71]) }),
      jsonBytes: () => ({ body: new Uint8Array([1, 2]) }),
    } as any);

    const upperJson = await router.handle(new Request("http://localhost/upper-json"));
    expect(upperJson.status).toBe(200);
    expect(upperJson.headers.get("content-type")).toBe("Application/JSON; Charset=utf-8");
    expect(await upperJson.json()).toEqual({ ok: true });

    const vendorJson = await router.handle(new Request("http://localhost/vendor-json"));
    expect(vendorJson.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
    expect(await vendorJson.json()).toEqual({ ok: false });

    const text = await router.handle(new Request("http://localhost/text-number"));
    expect(text.headers.get("content-type")).toBe("Text/Plain; Charset=utf-8");
    expect(await text.text()).toBe("42");

    const binary = await router.handle(new Request("http://localhost/binary"));
    expect(binary.headers.get("content-type")).toBe("Application/Octet-Stream");
    expect(await binary.text()).toBe("AB");

    const image = await router.handle(new Request("http://localhost/image"));
    expect(image.headers.get("content-type")).toBe("Image/PNG; Profile=raw");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));

    const jsonBytes = await router.handle(new Request("http://localhost/json-bytes"));
    expect(jsonBytes.headers.get("content-type")).toBe("application/json");
    expect(await jsonBytes.json()).toBe("AQI=");
  });

  test("rejects false JSON matches and incompatible response bodies", () => {
    const result = compileFixtureExpectingDiagnostics(
      "response-media-invalid",
      invalidResponseMediaSpec,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("unsupported-response-content-type");
    expect(diagnostics).toContain("application/notjson");
    expect(diagnostics).toContain("application/jsonp");
    expect(diagnostics).toContain("application/+json");
    expect(diagnostics).toContain("image/png");
    expect(diagnostics).toContain("not-a-media-type");
    expect(diagnostics).toContain("unsupported-response-body");
    expect(diagnostics).toContain("text responses require");
    expect(diagnostics).toContain("binary responses require");
    expect(diagnostics).toContain("multipart bodies require a dedicated response encoder");
    expect(result.listFiles("invalid-response-media-api")).toEqual([]);
  });
});
