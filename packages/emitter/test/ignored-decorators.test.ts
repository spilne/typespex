import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildEmitter,
  cleanupFixtures,
  compileFixture,
  compileFixtureCollectingDiagnostics,
  compileFixtureExpectingDiagnostics,
} from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const header = (title: string) => `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "${title}" })
namespace ${title};
`;

const encodeSpec = `${header("EncodeApi")}
model Event {
  @encode("epochDay", int32)
  createdAt: utcDateTime;
}
@route("/events") interface Events {
  @post create(@body body: Event): Event;
}
`;

const cleanSpec = `${header("CleanApi")}
model Item { id: string; createdAt: utcDateTime; }
@route("/items") interface Items {
  @get list(): Item[];
}
`;

const inheritedScalarEncodeSpec = `
import "@typespec/http";
using TypeSpec.Http;
@encode("epochDay", int32)
scalar EncodedInstant extends utcDateTime;
scalar DerivedInstant extends EncodedInstant;
@service namespace ScalarApi {
  model Event { createdAt: DerivedInstant; }
  @route("/events") @get op read(): Event;
}
`;

const sharedScalarEncodeSpec = `
import "@typespec/http";
using TypeSpec.Http;
@encode("epochDay", int32)
scalar EncodedInstant extends utcDateTime;
@service namespace SharedScalarApi {
  model Event { createdAt: EncodedInstant; }
  @route("/events") @post op create(@body body: Event): Event;
  @route("/events/{id}") @put op update(@path id: string, @body body: Event): Event;
}
`;

const multiServiceUnsupportedSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service namespace CleanService {
  model Item { id: string; }
  @route("/items") @get op list(): Item[];
}

@service namespace UnsupportedService {
  model Event {
    @encode("epochDay", int32)
    createdAt: utcDateTime;
  }
  @route("/events") @post op create(@body body: Event): Event;
}
`;

describe("unsupported decorator diagnostics", () => {
  for (const [decorator, fixture, source, diagnosticCode, target, serviceDir] of [
    [
      "custom @encode",
      "diag-encode",
      encodeSpec,
      "unsupported-scalar-encoding",
      "createdAt",
      "encode-api",
    ],
  ] as const) {
    test(`${decorator} fails generation`, () => {
      const result = compileFixtureExpectingDiagnostics(fixture, source);
      const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;
      expect(diagnostics).toContain(diagnosticCode);
      expect(diagnostics).toContain(target);
      expect(result.listFiles(serviceDir)).toEqual([]);
    });
  }

  test("specs without unsupported decorators stay silent", () => {
    const result = compileFixtureCollectingDiagnostics("diag-clean", cleanSpec);
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;
    expect(diagnostics).not.toContain("ignored-");
  });

  test("targets the scalar that declares an inherited @encode", () => {
    const result = compileFixtureExpectingDiagnostics(
      "inherited-scalar-encode",
      inheritedScalarEncodeSpec,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("unsupported-scalar-encoding");
    expect(diagnostics).toContain("main.tsp:5:8");
    expect(diagnostics).toContain("scalar EncodedInstant extends utcDateTime;");
    expect(result.listFiles("scalar-api")).toEqual([]);
  });

  test("reports reachable scalar encodings once for every affected operation", () => {
    const result = compileFixtureExpectingDiagnostics(
      "shared-scalar-encode",
      sharedScalarEncodeSpec,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(
      diagnostics.match(/@typespex\/emitter\/unsupported-scalar-encoding:/g) ?? [],
    ).toHaveLength(2);
    expect(diagnostics).toContain('operation "create" uses it at "body.createdAt"');
    expect(diagnostics).toContain('operation "update" uses it at "body.createdAt"');
    expect(result.listFiles("shared-scalar-api")).toEqual([]);
  });

  test("preflights every service before emitting generated files", () => {
    const result = compileFixtureExpectingDiagnostics(
      "unsupported-multi-service",
      multiServiceUnsupportedSpec,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("unsupported-scalar-encoding");
    expect(result.listFiles("clean-service")).toEqual([]);
    expect(result.listFiles("unsupported-service")).toEqual([]);
  });
});

describe("unsupported HTTP parameter serialization", () => {
  test("rejects object-valued query parameters", () => {
    const result = compileFixtureExpectingDiagnostics(
      "object-query",
      `
      import "@typespec/http";
      using TypeSpec.Http;

      @service namespace ObjectQueryApi {
        @route("/search") @get
        op search(@query(#{ explode: true }) filter: { role: string; active: boolean }): void;
      }
    `,
    );

    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;
    expect(diagnostics).toContain("unsupported-http-parameter");
    expect(diagnostics).toContain('HTTP query parameter "filter"');
    expect(result.listFiles("object-query-api")).toEqual([]);
  });

  test("rejects path styles the generated matcher cannot represent", () => {
    const result = compileFixtureExpectingDiagnostics(
      "path-style",
      `
      import "@typespec/http";
      using TypeSpec.Http;

      @service namespace PathStyleApi {
        @route("/files{/segments*}/metadata") @get
        op read(@path segments: string[]): void;
      }
    `,
    );

    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;
    expect(diagnostics).toContain("unsupported-http-parameter");
    expect(diagnostics).toContain('path style "path"');
    expect(result.listFiles("path-style-api")).toEqual([]);
  });

  test("rejects allowReserved parameters outside a complete terminal segment", () => {
    const result = compileFixtureExpectingDiagnostics(
      "reserved-path-shape",
      `
      import "@typespec/http";
      using TypeSpec.Http;

      @service namespace ReservedPathShapeApi {
        @route("/files/prefix{+value}") @get
        op read(@path value: string): void;
      }
    `,
    );

    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;
    expect(diagnostics).toContain("unsupported-http-parameter");
    expect(diagnostics).toContain(
      "allowReserved path values require one required scalar in a complete terminal path segment",
    );
    expect(result.listFiles("reserved-path-shape-api")).toEqual([]);
  });
});

describe("unsupported request body serialization", () => {
  test("rejects media-specific encoded names in form bodies", () => {
    const result = compileFixtureExpectingDiagnostics(
      "form-encoded-name",
      `
      import "@typespec/http";
      using TypeSpec.Http;

      @service namespace FormEncodedNameApi {
        model Input {
          @encodedName("application/x-www-form-urlencoded", "wire_name")
          name: string;
        }

        @route("/items") @post
        op create(
          @header contentType: "application/x-www-form-urlencoded",
          @body body: Input,
        ): void;
      }
    `,
    );

    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;
    expect(diagnostics).toContain("ignored-encoded-name");
    expect(diagnostics).toContain("name");
    expect(result.listFiles("form-encoded-name-api")).toEqual([]);
  });

  test("rejects @encode directly on an explicit body property", () => {
    const result = compileFixtureExpectingDiagnostics(
      "explicit-body-encode",
      `
      import "@typespec/http";
      using TypeSpec.Http;

      @service namespace ExplicitBodyEncodeApi {
        @route("/upload") @post
        op upload(@body @encode("base64url") body: bytes): void;
      }
    `,
    );

    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;
    expect(diagnostics).toContain("unsupported-request-body");
    expect(diagnostics).toContain("binary bodies cannot apply scalar encoding");
    expect(diagnostics).toContain("body");
    expect(result.listFiles("explicit-body-encode-api")).toEqual([]);
  });

  test("rejects object bodies declared as text", () => {
    const result = compileFixtureExpectingDiagnostics(
      "object-text-body",
      `
      import "@typespec/http";
      using TypeSpec.Http;

      @service namespace ObjectTextBodyApi {
        @route("/items") @post
        op create(
          @header contentType: "text/plain",
          @body body: { name: string },
        ): void;
      }
    `,
    );

    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;
    expect(diagnostics).toContain("unsupported-request-body");
    expect(diagnostics).toContain("text bodies require a scalar");
    expect(result.listFiles("object-text-body-api")).toEqual([]);
  });

  test("rejects malformed request and multipart-part content types", () => {
    const result = compileFixtureExpectingDiagnostics(
      "malformed-request-content-types",
      `
      import "@typespec/http";
      using TypeSpec.Http;

      model InvalidPart {
        @header contentType: "not-a-media-type";
        @body value: string;
      }

      @service namespace MalformedRequestContentTypesApi {
        @route("/direct") @post
        op direct(
          @header contentType: "also-invalid",
          @body body: string,
        ): void;

        @route("/multipart") @post
        op multipart(
          @multipartBody body: {
            part: HttpPart<InvalidPart>;
          },
        ): void;
      }
    `,
    );

    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;
    expect(diagnostics).toContain("unsupported-request-body");
    expect(diagnostics).toContain("also-invalid");
    expect(diagnostics).toContain("not-a-media-type");
    expect(diagnostics).toContain("content type must be a valid type/subtype media type");
    expect(diagnostics).toContain('multipart part "part"');
    expect(result.listFiles("malformed-request-content-types-api")).toEqual([]);
  });

  test("rejects nested URL-encoded form bodies", () => {
    const result = compileFixtureExpectingDiagnostics(
      "nested-form-body",
      `
      import "@typespec/http";
      using TypeSpec.Http;

      model Profile { name: string; }
      @service namespace NestedFormBodyApi {
        @route("/profiles") @post
        op create(
          @header contentType: "application/x-www-form-urlencoded",
          @body body: { profile: Profile },
        ): void;
      }
    `,
    );

    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;
    expect(diagnostics).toContain("unsupported-request-body");
    expect(diagnostics).toContain("URL-encoded forms require a flat model");
    expect(result.listFiles("nested-form-body-api")).toEqual([]);
  });

  test("accepts URL-encoded form records with scalar-array values", () => {
    const result = compileFixture(
      "form-record-arrays",
      `
      import "@typespec/http";
      using TypeSpec.Http;

      @service namespace FormRecordArraysApi {
        @route("/tags") @post
        op update(
          @header contentType: "application/x-www-form-urlencoded",
          @body body: Record<string[]>,
        ): void;
      }
    `,
    );

    expect(result.listFiles("form-record-arrays-api")).not.toEqual([]);
    result.typecheck("form-record-arrays-api");
  });
});
