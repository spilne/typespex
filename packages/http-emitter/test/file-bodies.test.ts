import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildEmitter,
  cleanupFixtures,
  compileFixture,
  compileFixtureExpectingDiagnostics,
} from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const fileBodiesSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "FileBodiesApi" })
namespace FileBodiesApi;

model BinaryFile extends File<"application/octet-stream"> {}
model TextFile extends File<"text/plain" | "application/yaml", string> {}
model NamedUpload extends File<"application/octet-stream"> {
  @header("x-filename") filename: string;
}
model QueryNamedUpload extends File<"application/octet-stream"> {
  @query filename: string;
}
model PathNamedUpload extends File<"application/octet-stream"> {
  @path filename: string;
}
model RequiredContentFile extends File<"image/png"> {
  contentType: "image/png";
}
model RequiredMetadataFile extends RequiredContentFile {
  filename: string;
}

model StructuredFileResponse {
  @header contentType: "application/json";
  @body file: File<"image/png", bytes>;
}

model FileWithHeader {
  @header etag: string;
  @bodyRoot file: BinaryFile;
}

@route("/binary")
@get
op downloadBinary(): BinaryFile;

@route("/text")
@get
op downloadText(): TextFile;

@route("/with-header")
@get
op downloadWithHeader(): FileWithHeader;

@route("/binary")
@post
op uploadBinary(@bodyRoot file: BinaryFile): void;

@route("/raw-json")
@post
op uploadRawJson(@bodyRoot file: File<"application/json", string>): void;

@route("/named")
@post
op uploadNamed(@bodyRoot file: NamedUpload): void;

@route("/named-query")
@post
op uploadNamedQuery(@bodyRoot file: QueryNamedUpload): void;

@route("/named-path/{filename}")
@post
op uploadNamedPath(@bodyRoot file: PathNamedUpload): void;

@route("/named-download")
@get
op downloadNamed(): NamedUpload;

@route("/required-content")
@post
op uploadRequiredContent(@bodyRoot file: RequiredContentFile): void;

@route("/required-metadata")
@get
op downloadRequiredMetadata(): RequiredMetadataFile;

@route("/structured-json")
@post
op uploadStructuredJson(
  @header contentType: "application/json",
  @body file: File<"image/png", bytes>,
): void;

@route("/structured-json")
@get
op downloadStructuredJson(): StructuredFileResponse;

@route("/multipart")
@post
op uploadMultipart(
  @multipartBody form: {
    file: HttpPart<File<"image/png">>;
  },
): void;

@route("/multipart-required")
@post
op uploadMultipartRequired(
  @multipartBody form: {
    file: HttpPart<RequiredContentFile>;
  },
): void;
`;

const unsupportedFileContentsSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "ConstrainedFiles" })
namespace ConstrainedFiles;

@minLength(5)
scalar BaseText extends string;
scalar LongText extends BaseText;

model ConstrainedFile extends File<"text/plain", LongText> {}

@post
op upload(@bodyRoot file: ConstrainedFile): void;
`;

const unsupportedFileResponseContentsSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "ConstrainedFileResponses" })
namespace ConstrainedFileResponses;

@minLength(5)
scalar BaseText extends string;
scalar LongText extends BaseText;

model ConstrainedFile extends File<"text/plain", LongText> {}

@get
op download(): ConstrainedFile;
`;

const requiredUnlocatedFilenameSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "RequiredFilename" })
namespace RequiredFilename;

model NamedFile extends File<"image/png"> {
  filename: string;
}

@post
op upload(@bodyRoot file: NamedFile): void;
`;

describe("TypeSpec HTTP File bodies", () => {
  test("uses Web File for raw/multipart transport and a structural object for JSON", async () => {
    const result = compileFixture("file-bodies", fileBodiesSpec);
    const server = result.readFile("file-bodies-api", "server.ts");
    const operations = result.readFile("file-bodies-api", "server-operations.ts");

    expect(server).toContain(
      "readonly downloadBinary: OperationHandler<Record<string, never>, File, Ctx>",
    );
    expect(server).toMatch(
      /readonly downloadWithHeader: OperationHandler<\s*Record<string, never>,\s*\{ file: File; etag: string \},\s*Ctx\s*>/,
    );
    expect(server).toContain("readonly uploadBinary: OperationHandler<File, void, Ctx>");
    expect(server).toMatch(
      /readonly downloadNamed: OperationHandler<\s*Record<string, never>,\s*\{ body: File; filename: string \},\s*Ctx\s*>/,
    );
    expect(server).toContain("readonly uploadRequiredContent: OperationHandler<File, void, Ctx>");
    expect(server).toMatch(
      /readonly uploadStructuredJson: OperationHandler<\s*\{\s*contentType: "application\/json";\s*body: \{\s*contentType\?: "image\/png";\s*filename\?: string;\s*contents: Uint8Array\s*\};\s*\},\s*void,\s*Ctx\s*>/,
    );
    expect(server).toMatch(
      /readonly downloadStructuredJson: OperationHandler<\s*Record<string, never>,\s*\{\s*file: \{\s*contentType\?: "image\/png";\s*filename\?: string;\s*contents: Uint8Array\s*\}\s*\},\s*Ctx\s*>/,
    );
    expect(operations).toMatch(/kind: "file",\s*contentTypes: \["application\/octet-stream"\]/);
    expect(operations).toMatch(
      /kind: "file",\s*contentTypes: \["text\/plain", "application\/yaml"\]/,
    );
    expect(operations).toMatch(
      /decoder: Decoders\.file,\s*kind: "file",\s*contentTypes: \["image\/png"\]/,
    );
    expect(operations).toMatch(
      /decoder: Decoders\.file,\s*kind: "file",\s*contentTypes: \["image\/png"\],\s*requireContentType: true/,
    );
    expect(operations).toMatch(/fileNameProperty:\s*"filename",\s*fileBodyProperty:\s*"body"/);
    expect(operations).toMatch(
      /kind: "file",\s*contentTypes: \["image\/png"\],\s*requireFileContentType: true,\s*requireFileName: true/,
    );
    expect(operations).toMatch(
      /kind: "file",\s*contentTypes: \["application\/octet-stream"\],\s*emitFileContentDisposition: false/,
    );
    result.typecheck("file-bodies-api");

    let binaryUpload: File | undefined;
    let rawJsonUpload: File | undefined;
    let namedUpload: File | undefined;
    let namedUploadHeader: string | undefined;
    let queryNamedUpload: File | undefined;
    let pathNamedUpload: File | undefined;
    let requiredContentUpload: File | undefined;
    let structuredUpload:
      | {
          contentType?: "image/png";
          filename?: string;
          contents: Uint8Array;
        }
      | undefined;
    let multipartUpload: File | undefined;

    const { createFileBodiesApiServerRouter } = await import(
      `${result.outputDir}/file-bodies-api/server-router.ts`
    );
    const router = createFileBodiesApiServerRouter({
      downloadBinary: () =>
        new File([new Uint8Array([65, 66])], "archive.bin", {
          type: "application/octet-stream",
        }),
      downloadText: () => new File(["hello file"], "hello.yaml", { type: "application/yaml" }),
      downloadWithHeader: () => ({
        etag: '"file-v1"',
        file: new File(["wrapped"], "wrapped.bin", {
          type: "application/octet-stream",
        }),
      }),
      uploadBinary: (file: File) => {
        binaryUpload = file;
      },
      uploadRawJson: (file: File) => {
        rawJsonUpload = file;
      },
      uploadNamed: (input: { filename: string; body: File }) => {
        namedUploadHeader = input.filename;
        namedUpload = input.body;
      },
      uploadNamedQuery: (input: { filename: string; body: File }) => {
        queryNamedUpload = input.body;
      },
      uploadNamedPath: (input: { filename: string; body: File }) => {
        pathNamedUpload = input.body;
      },
      downloadNamed: () => ({
        filename: "header-name.bin",
        body: new File(["named"], "default-name.bin", {
          type: "application/octet-stream",
        }),
      }),
      uploadRequiredContent: (file: File) => {
        requiredContentUpload = file;
      },
      downloadRequiredMetadata: () =>
        new File(["required"], "", {
          type: "image/png",
        }),
      uploadStructuredJson: ({
        body,
      }: {
        contentType: "application/json";
        body: NonNullable<typeof structuredUpload>;
      }) => {
        structuredUpload = body;
      },
      downloadStructuredJson: () => ({
        file: {
          contentType: "image/png",
          filename: "pixel.png",
          contents: new Uint8Array([1, 2, 255]),
        },
      }),
      uploadMultipart: ({ file }: { file: File }) => {
        multipartUpload = file;
      },
      uploadMultipartRequired: () => {},
    } as any);

    const binary = await router.handle(new Request("http://localhost/binary"));
    expect(binary.status).toBe(200);
    expect(binary.headers.get("content-type")).toBe("application/octet-stream");
    expect(binary.headers.get("content-disposition")).toBe('attachment; filename="archive.bin"');
    expect(new Uint8Array(await binary.arrayBuffer())).toEqual(new Uint8Array([65, 66]));

    const text = await router.handle(new Request("http://localhost/text"));
    expect(text.headers.get("content-type")).toBe("application/yaml");
    expect(text.headers.get("content-disposition")).toBe('attachment; filename="hello.yaml"');
    expect(await text.text()).toBe("hello file");

    const withHeader = await router.handle(new Request("http://localhost/with-header"));
    expect(withHeader.headers.get("etag")).toBe('"file-v1"');
    expect(withHeader.headers.get("content-type")).toBe("application/octet-stream");
    expect(withHeader.headers.get("content-disposition")).toBe(
      'attachment; filename="wrapped.bin"',
    );
    expect(await withHeader.text()).toBe("wrapped");

    const binaryUploadResponse = await router.handle(
      new Request("http://localhost/binary", {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
        },
        body: new Uint8Array([1, 2, 3]),
      }),
    );
    expect(binaryUploadResponse.status).toBe(204);
    expect(binaryUpload).toBeInstanceOf(File);
    expect(binaryUpload?.name).toBe("");
    expect(binaryUpload?.type).toBe("application/octet-stream");
    expect(new Uint8Array(await binaryUpload!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

    const wrongType = await router.handle(
      new Request("http://localhost/binary", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "wrong",
      }),
    );
    expect(wrongType.status).toBe(415);

    const missingBody = await router.handle(
      new Request("http://localhost/binary", { method: "POST" }),
    );
    expect(missingBody.status).toBe(400);

    const missingContentType = await router.handle(
      new Request("http://localhost/binary", {
        method: "POST",
        body: new Uint8Array([4]),
      }),
    );
    expect(missingContentType.status).toBe(204);
    expect(binaryUpload?.type).toBe("");
    expect(new Uint8Array(await binaryUpload!.arrayBuffer())).toEqual(new Uint8Array([4]));

    const zeroByte = await router.handle(
      new Request("http://localhost/binary", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(),
      }),
    );
    expect(zeroByte.status).toBe(204);
    expect(binaryUpload?.size).toBe(0);

    const rawJsonResponse = await router.handle(
      new Request("http://localhost/raw-json", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"still":"raw"}',
      }),
    );
    expect(rawJsonResponse.status).toBe(204);
    expect(rawJsonUpload).toBeInstanceOf(File);
    expect(rawJsonUpload?.type).toBe("application/json");
    expect(await rawJsonUpload!.text()).toBe('{"still":"raw"}');

    const namedUploadResponse = await router.handle(
      new Request("http://localhost/named", {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-filename": "modeled.bin",
        },
        body: new Uint8Array([7]),
      }),
    );
    expect(namedUploadResponse.status).toBe(204);
    expect(namedUploadHeader).toBe("modeled.bin");
    expect(namedUpload?.name).toBe("modeled.bin");
    expect(new Uint8Array(await namedUpload!.arrayBuffer())).toEqual(new Uint8Array([7]));

    const queryNamedResponse = await router.handle(
      new Request("http://localhost/named-query?filename=query.bin", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([8]),
      }),
    );
    expect(queryNamedResponse.status).toBe(204);
    expect(queryNamedUpload?.name).toBe("query.bin");

    const pathNamedResponse = await router.handle(
      new Request("http://localhost/named-path/path%20name.bin", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([9]),
      }),
    );
    expect(pathNamedResponse.status).toBe(204);
    expect(pathNamedUpload?.name).toBe("path name.bin");

    const namedDownload = await router.handle(new Request("http://localhost/named-download"));
    expect(namedDownload.status).toBe(200);
    expect(namedDownload.headers.get("x-filename")).toBe("header-name.bin");
    expect(namedDownload.headers.get("content-disposition")).toBeNull();
    expect(await namedDownload.text()).toBe("named");

    const requiredContentMissing = await router.handle(
      new Request("http://localhost/required-content", {
        method: "POST",
        body: new Uint8Array([1]),
      }),
    );
    expect(requiredContentMissing.status).toBe(415);

    const requiredContentWrongWithoutBody = await router.handle(
      new Request("http://localhost/required-content", {
        method: "POST",
        headers: { "content-type": "text/plain" },
      }),
    );
    expect(requiredContentWrongWithoutBody.status).toBe(415);

    const requiredContentValid = await router.handle(
      new Request("http://localhost/required-content", {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: new Uint8Array([2]),
      }),
    );
    expect(requiredContentValid.status).toBe(204);
    expect(requiredContentUpload?.type).toBe("image/png");

    const requiredMetadata = await router.handle(new Request("http://localhost/required-metadata"));
    expect(requiredMetadata.status).toBe(200);
    expect(requiredMetadata.headers.get("content-type")).toBe("image/png");
    expect(requiredMetadata.headers.get("content-disposition")).toBe('attachment; filename=""');

    const structuredJsonResponse = await router.handle(
      new Request("http://localhost/structured-json", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contentType: "image/png",
          filename: "upload.png",
          contents: "AQL/",
        }),
      }),
    );
    expect(structuredJsonResponse.status).toBe(204);
    expect(structuredUpload).not.toBeInstanceOf(File);
    expect(structuredUpload?.contentType).toBe("image/png");
    expect(structuredUpload?.filename).toBe("upload.png");
    expect(structuredUpload?.contents).toEqual(new Uint8Array([1, 2, 255]));

    const structured = await router.handle(new Request("http://localhost/structured-json"));
    expect(structured.headers.get("content-type")).toBe("application/json");
    expect(await structured.json()).toEqual({
      contentType: "image/png",
      filename: "pixel.png",
      contents: "AQL/",
    });

    const form = new FormData();
    form.set("file", new File([new Uint8Array([9, 8])], "part.png", { type: "image/png" }));
    const multipart = await router.handle(
      new Request("http://localhost/multipart", {
        method: "POST",
        body: form,
      }),
    );
    expect(multipart.status).toBe(204);
    expect(multipartUpload).toBeInstanceOf(File);
    expect(multipartUpload?.name).toBe("part.png");
    expect(multipartUpload?.type).toBe("image/png");
    expect(new Uint8Array(await multipartUpload!.arrayBuffer())).toEqual(new Uint8Array([9, 8]));

    const wrongForm = new FormData();
    wrongForm.set("file", new File(["not png"], "part.txt", { type: "text/plain" }));
    const wrongMultipart = await router.handle(
      new Request("http://localhost/multipart", {
        method: "POST",
        body: wrongForm,
      }),
    );
    expect(wrongMultipart.status).toBe(400);
  });

  test("rejects raw File contents constraints that the Web File boundary cannot enforce", () => {
    const result = compileFixtureExpectingDiagnostics(
      "constrained-file-contents",
      unsupportedFileContentsSpec,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;
    expect(diagnostics).toContain("unsupported-request-body");
    expect(diagnostics).toContain("@minLength");
    expect(result.listFiles("constrained-files")).toEqual([]);

    const responseResult = compileFixtureExpectingDiagnostics(
      "constrained-file-response-contents",
      unsupportedFileResponseContentsSpec,
    );
    const responseDiagnostics = `${responseResult.diagnostics.stdout}\n${responseResult.diagnostics.stderr}`;
    expect(responseDiagnostics).toContain("unsupported-response-body");
    expect(responseDiagnostics).toContain("@minLength");
    expect(responseResult.listFiles("constrained-file-responses")).toEqual([]);
  });

  test("rejects a required request filename without an HTTP input location", () => {
    const result = compileFixtureExpectingDiagnostics(
      "required-file-filename",
      requiredUnlocatedFilenameSpec,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;
    expect(diagnostics).toContain("unsupported-request-body");
    expect(diagnostics).toContain("needs an explicit path, query, or header location");
    expect(result.listFiles("required-filename")).toEqual([]);
  });
});
