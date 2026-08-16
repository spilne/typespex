import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildEmitter,
  cleanupFixtures,
  compileFixture,
  compileFixtureExpectingDiagnostics,
} from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const multipartMixedSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "MultipartMixedApi" })
namespace MultipartMixedApi;

model HeaderNamedFile extends File<"image/png" | "image/jpeg"> {
  @header("x-filename") filename?: string;
}

model RequiredHeaderNamedFile extends File<"image/png"> {
  @header("x-required-filename") filename: string;
  contentType: "image/png";
}

model JsonPart {
  @header contentType: "application/json";
  @body payload: {
    id: string;
  };
}

model FlexibleTextPart {
  @header contentType: "application/json" | "text/plain";
  @body payload: string;
}

@route("/ordered")
@post
op ordered(
  @header contentType: "multipart/mixed",
  @multipartBody body: [
    HttpPart<string>,
    HttpPart<File>
  ],
): void;

@route("/metadata")
@post
op withMetadata(
  @header contentType: "multipart/mixed",
  @query trace: string,
  @multipartBody payload: [
    HttpPart<JsonPart>,
    HttpPart<HeaderNamedFile>
  ],
): void;

@route("/repeated")
@post
op repeated(
  @header contentType: "multipart/mixed",
  @multipartBody payload: [
    HttpPart<string>[],
    HttpPart<File<"application/octet-stream">>
  ],
): void;

@route("/optional")
@post
op optional(
  @header contentType: "multipart/mixed",
  @multipartBody payload?: [
    HttpPart<string>,
    HttpPart<File>
  ],
): void;

@route("/tuple-form")
@post
op tupleForm(
  @multipartBody payload: [
    HttpPart<string, #{ name: "label" }>,
    HttpPart<File, #{ name: "attachment" }>
  ],
): void;

@route("/named")
@post
op named(
  @multipartBody form: {
    sourceLabel: HttpPart<string, #{ name: "wire-label" }>;
    maybe?: HttpPart<HeaderNamedFile>;
    requiredFile: HttpPart<RequiredHeaderNamedFile>;
    many: HttpPart<string>[];
  },
): void;

@route("/mixed-kinds")
@post
op mixedKinds(
  @header contentType: "multipart/mixed",
  @multipartBody payload: [
    HttpPart<FlexibleTextPart>
  ],
): void;

@route("/model-mixed")
@post
op modelMixed(
  @header contentType: "multipart/mixed",
  @multipartBody payload: {
    sourceValue: HttpPart<string, #{ name: "wire-source" }>;
    file: HttpPart<File>;
  },
): void;
`;

const unsupportedPartHeaderSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "UnsupportedPartHeaderApi" })
namespace UnsupportedPartHeaderApi;

model PartWithHeader {
  @header("x-part-id") partId: string;
  @body value: string;
}

@post
op upload(
  @multipartBody body: {
    value: HttpPart<PartWithHeader>;
  },
): void;
`;

const duplicatePartNameSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "DuplicatePartNameApi" })
namespace DuplicatePartNameApi;

@post
op upload(
  @multipartBody body: {
    first: HttpPart<string, #{ name: "same" }>;
    second: HttpPart<string, #{ name: "same" }>;
  },
): void;
`;

describe("multipart/mixed input emission", () => {
  test("preserves tuple order, source names, multiplicity, and part metadata", async () => {
    const result = compileFixture("multipart-mixed", multipartMixedSpec);
    const server = result.readFile("multipart-mixed-api", "server.ts");
    const operations = result.readFile("multipart-mixed-api", "server-operations.ts");
    const compactServer = server.replace(/\s+/g, " ");
    const compactOperations = operations.replace(/\s+/g, " ");

    expect(compactServer).toContain(
      'readonly ordered: OperationHandler< { contentType: "multipart/mixed"; body: [string, File] }, void, Ctx >',
    );
    expect(compactServer).toContain(
      'readonly withMetadata: OperationHandler< { contentType: "multipart/mixed"; trace: string; body: [{ id: string }, File] }, void, Ctx >',
    );
    expect(compactServer).toContain(
      'readonly repeated: OperationHandler< { contentType: "multipart/mixed"; body: [string[], File] }, void, Ctx >',
    );
    expect(compactServer).toContain(
      "readonly named: OperationHandler< { sourceLabel: string; maybe?: File; requiredFile: File; many: string[] }, void, Ctx >",
    );
    expect(compactServer).toContain(
      'readonly mixedKinds: OperationHandler< { contentType: "multipart/mixed"; body: [string] }, void, Ctx >',
    );
    expect(compactServer).toContain(
      'readonly optional: OperationHandler< { contentType: "multipart/mixed"; body?: [string, File] }, void, Ctx >',
    );
    expect(compactServer).toContain(
      'readonly modelMixed: OperationHandler< { contentType: "multipart/mixed"; sourceValue: string; file: File }, void, Ctx >',
    );
    expect(server).toContain("readonly tupleForm: OperationHandler<[string, File], void, Ctx>");
    expect(server).not.toContain("wire-label: string");

    expect(compactOperations).toContain("Decoders.multipartTuple<[string, File]>");
    expect(compactOperations).toContain(
      'decoder: Decoders.string, kind: "text", contentTypes: ["text/plain"]',
    );
    expect(compactOperations).toContain(
      'decoder: Decoders.file, kind: "file", contentTypes: ["image/png", "image/jpeg"]',
    );
    expect(compactOperations).toContain('fileNameHeader: "x-filename"');
    expect(compactOperations).toContain('fileNameHeader: "x-required-filename"');
    expect(compactOperations).toContain("requireFileName: true");
    expect(compactOperations).toContain("requireContentType: true");
    expect(compactOperations).toContain('name: "wire-label", property: "sourceLabel"');
    expect(compactOperations).toContain('name: "label"');
    expect(compactOperations).toContain('name: "attachment"');
    expect(compactOperations).toContain("optional: true");
    expect(compactOperations).toContain("multi: true");
    expect(compactOperations).toContain(
      "decoders: { json: Decoders.string, text: Decoders.string }",
    );
    expect(compactOperations).toContain(
      'decoder: Decoders.object<{ id: string }>({ id: Decoders.string }, { allowUnknown: true }), kind: "json", contentTypes: ["application/json"]',
    );

    result.typecheck("multipart-mixed-api");

    const { createMultipartMixedApiServerRouter } = await import(
      `${result.outputDir}/multipart-mixed-api/server-router.ts`
    );
    let orderedInput: { contentType: "multipart/mixed"; body: [string, File] } | undefined;
    let metadataInput:
      | {
          contentType: "multipart/mixed";
          trace: string;
          body: [{ id: string }, File];
        }
      | undefined;
    let modelMixedInput:
      | {
          contentType: "multipart/mixed";
          sourceValue: string;
          file: File;
        }
      | undefined;
    const router = createMultipartMixedApiServerRouter({
      ordered: (input: typeof orderedInput) => {
        orderedInput = input;
      },
      withMetadata: (input: typeof metadataInput) => {
        metadataInput = input;
      },
      repeated: () => {},
      optional: () => {},
      tupleForm: () => {},
      named: () => {},
      mixedKinds: () => {},
      modelMixed: (input: typeof modelMixedInput) => {
        modelMixedInput = input;
      },
    } as any);

    const orderedBoundary = "typespex-ordered";
    const orderedResponse = await router.handle(
      new Request("http://localhost/ordered", {
        method: "POST",
        headers: {
          "content-type": `multipart/mixed; boundary=${orderedBoundary}`,
        },
        body: [
          `--${orderedBoundary}`,
          "Content-Type: text/plain",
          "",
          "hello",
          `--${orderedBoundary}`,
          "Content-Type: application/octet-stream",
          'Content-Disposition: attachment; filename="payload.bin"',
          "",
          "file-body",
          `--${orderedBoundary}--`,
          "",
        ].join("\r\n"),
      }),
    );

    expect(orderedResponse.status).toBe(204);
    expect(orderedInput?.contentType).toBe("multipart/mixed");
    expect(orderedInput?.body[0]).toBe("hello");
    expect(orderedInput?.body[1]).toBeInstanceOf(File);
    expect(orderedInput?.body[1].name).toBe("payload.bin");
    expect(await orderedInput?.body[1].text()).toBe("file-body");

    const metadataBoundary = "typespex-metadata";
    const metadataResponse = await router.handle(
      new Request("http://localhost/metadata?trace=request-trace", {
        method: "POST",
        headers: {
          "content-type": `multipart/mixed; boundary=${metadataBoundary}`,
        },
        body: [
          `--${metadataBoundary}`,
          "Content-Type: application/json",
          "",
          '{"id":"json-part"}',
          `--${metadataBoundary}`,
          "Content-Type: image/png",
          "X-Filename: relocated.png",
          "",
          "png-body",
          `--${metadataBoundary}--`,
          "",
        ].join("\r\n"),
      }),
    );

    expect(metadataResponse.status).toBe(204);
    expect(metadataInput?.trace).toBe("request-trace");
    expect(metadataInput?.body[0]).toEqual({ id: "json-part" });
    expect(metadataInput?.body[1].name).toBe("relocated.png");
    expect(metadataInput?.body[1].type).toBe("image/png");

    const modelBoundary = "typespex-model";
    const modelResponse = await router.handle(
      new Request("http://localhost/model-mixed", {
        method: "POST",
        headers: {
          "content-type": `multipart/mixed; boundary=${modelBoundary}`,
        },
        body: [
          `--${modelBoundary}`,
          'Content-Disposition: attachment; name="wire-source"',
          "Content-Type: text/plain",
          "",
          "source-body",
          `--${modelBoundary}`,
          'Content-Disposition: attachment; name="file"; filename="mixed.bin"',
          "Content-Type: application/octet-stream",
          "",
          "mixed-file",
          `--${modelBoundary}--`,
          "",
        ].join("\r\n"),
      }),
    );

    expect(modelResponse.status).toBe(204);
    expect(modelMixedInput?.sourceValue).toBe("source-body");
    expect(modelMixedInput?.file.name).toBe("mixed.bin");
    expect(await modelMixedInput?.file.text()).toBe("mixed-file");
  });

  test("rejects part headers that cannot be represented by the handler contract", () => {
    const result = compileFixtureExpectingDiagnostics(
      "unsupported-multipart-part-header",
      unsupportedPartHeaderSpec,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("only a File filename header can currently be represented");
    expect(result.listFiles("unsupported-part-header-api")).toEqual([]);
  });

  test("rejects duplicate model wire names before emitting an unusable schema", () => {
    const result = compileFixtureExpectingDiagnostics(
      "duplicate-multipart-part-name",
      duplicatePartNameSpec,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain(
      'multipart properties "first" and "second" share wire part name "same"',
    );
    expect(result.listFiles("duplicate-part-name-api")).toEqual([]);
  });
});
