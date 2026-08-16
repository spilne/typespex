import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildEmitter, cleanupFixtures, compileFixture } from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const sameEndpointOverloadsSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service namespace UploadApi;

@route("/upload")
@post
op upload(
  @body data: string | bytes,
  @header contentType: "text/plain" | "application/octet-stream",
): void;

@overload(upload)
op uploadText(
  @body data: string,
  @header contentType: "text/plain",
): void;

@overload(upload)
op uploadBytes(
  @body data: bytes,
  @header contentType: "application/octet-stream",
): void;
`;

describe("operation overloads", () => {
  test("uses the base operation as the single same-endpoint server contract", async () => {
    const result = compileFixture("same-endpoint-overloads", sameEndpointOverloadsSpec);
    const server = result.readFile("upload-api", "server.ts");
    const operations = result.readFile("upload-api", "server-operations.ts");
    const routerSource = result.readFile("upload-api", "server-router.ts");

    expect(server).toContain("readonly upload: OperationHandler<");
    expect(server).toContain('contentType: "text/plain" | "application/octet-stream"');
    expect(server).toContain("body: string | Uint8Array");
    expect(server).not.toContain("uploadText");
    expect(server).not.toContain("uploadBytes");
    expect(operations.match(/satisfies ServerOperation</g)).toHaveLength(1);
    expect(operations).toContain('operationId: "UploadApi.upload"');
    expect(operations).toContain("text: Decoders.string.map((body)");
    expect(operations).toContain("binary: Decoders.bytes.map((body)");
    expect(operations).not.toContain("uploadText");
    expect(operations).not.toContain("uploadBytes");
    expect(routerSource.match(/bindRoute\(/g)).toHaveLength(1);
    result.typecheck("upload-api");

    const { createUploadApiServerRouter } = await import(
      `${result.outputDir}/upload-api/server-router.ts`
    );
    const received: Array<{ contentType: string; body: string | Uint8Array }> = [];
    const router = createUploadApiServerRouter({
      upload(input: { contentType: string; body: string | Uint8Array }) {
        received.push(input);
      },
    });

    const textResponse = await router.handle(
      new Request("http://localhost/upload", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "hello",
      }),
    );
    const bytesResponse = await router.handle(
      new Request("http://localhost/upload", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([1, 2, 3]),
      }),
    );

    expect([textResponse.status, bytesResponse.status]).toEqual([204, 204]);
    expect(received[0]).toEqual({ contentType: "text/plain", body: "hello" });
    expect(received[1]?.contentType).toBe("application/octet-stream");
    expect([...((received[1]?.body as Uint8Array) ?? [])]).toEqual([1, 2, 3]);
  });

  test("keeps overloads that change route or verb as distinct endpoints", async () => {
    const result = compileFixture(
      "different-endpoint-overloads",
      `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace VariantUploadApi;

        @route("/upload") @put
        op upload(
          @body data: string | int32,
          @header contentType: "text/plain",
        ): void;

        @overload(upload) @route("/upload/text")
        op uploadText(
          @body data: string,
          @header contentType: "text/plain",
        ): void;

        @overload(upload) @post
        op uploadNumber(
          @body data: int32,
          @header contentType: "text/plain",
        ): void;
      `,
    );
    const server = result.readFile("variant-upload-api", "server.ts");
    const operations = result.readFile("variant-upload-api", "server-operations.ts");
    const router = result.readFile("variant-upload-api", "server-router.ts");

    expect(server).toContain("readonly upload: OperationHandler<");
    expect(server).toContain("readonly uploadText: OperationHandler<");
    expect(server).toContain("readonly uploadNumber: OperationHandler<");
    expect(operations.match(/satisfies ServerOperation</g)).toHaveLength(3);
    expect(operations).toContain('method: "PUT" as const');
    expect(operations).toContain('path: "/upload/text"');
    expect(operations).toContain('method: "POST" as const');
    expect(router.match(/bindRoute\(/g)).toHaveLength(3);
    result.typecheck("variant-upload-api");

    const { createVariantUploadApiServerRouter } = await import(
      `${result.outputDir}/variant-upload-api/server-router.ts`
    );
    const calls: string[] = [];
    const runtimeRouter = createVariantUploadApiServerRouter({
      upload() {
        calls.push("base");
      },
      uploadText() {
        calls.push("text");
      },
      uploadNumber() {
        calls.push("number");
      },
    });

    const responses = await Promise.all([
      runtimeRouter.handle(
        new Request("http://localhost/upload", {
          method: "PUT",
          headers: { "content-type": "text/plain" },
          body: "base",
        }),
      ),
      runtimeRouter.handle(
        new Request("http://localhost/upload/text", {
          method: "PUT",
          headers: { "content-type": "text/plain" },
          body: "text",
        }),
      ),
      runtimeRouter.handle(
        new Request("http://localhost/upload", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "42",
        }),
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([204, 204, 204]);
    expect(calls.sort()).toEqual(["base", "number", "text"]);
  });
});
