import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildEmitter, cleanupFixtures, compileFixture } from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const paramsSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "ParamsApi" })
namespace ParamsApi;

model Item { id: string; name: string; }

@route("/items")
interface Items {
  @get list(
    @query limit?: int32,
    @query offset?: int32,
    @header("x-request-id") requestId?: string,
  ): Item[];
}
`;

const validationSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "ValidationApi" })
namespace ValidationApi;

model CreateItem {
  @minLength(1) @maxLength(20)
  @pattern("^[A-Z].*", "Must start with uppercase.")
  name: string;

  @minItems(1) @maxItems(3)
  tags: string[];

  @minValue(0)
  count: int32;
}

@route("/items")
interface Items {
  @get list(
    @minValue(1) @maxValue(100) @query limit: int32,
    @minValueExclusive(0) @maxValueExclusive(1) @query ratio: float64,
  ): CreateItem[];

  @route("/{itemId}")
  @get read(@minValue(1) @path itemId: int64): CreateItem;

  @post create(@body body: CreateItem): CreateItem;
}
`;

const combinedSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "CombinedApi" })
namespace CombinedApi;

model UpdatePayload { name: string; tags?: string[]; }
model Item { id: string; name: string; tags?: string[]; }

@route("/items")
interface Items {
  @put update(
    @path itemId: string,
    @query dryRun?: boolean,
    @body body: UpdatePayload,
  ): Item;
}
`;

const cookieSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "CookieApi" })
namespace CookieApi;

model Profile { name: string; }

@route("/profile")
interface Users {
  @get me(@cookie sessionId: string, @cookie theme?: string): Profile;
}
`;

const recursiveSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "TreeApi" })
namespace TreeApi;

model TreeNode {
  value: string;
  children?: TreeNode[];
}

@route("/tree")
interface Tree {
  @post create(@body body: TreeNode): TreeNode;
}
`;

const multipartSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "UploadApi" })
namespace UploadApi;

model UploadResult { id: string; size: int32; }

@route("/upload")
interface Uploads {
  @route("/single") @post single(
    @multipartBody body: {
      name: HttpPart<string>;
      file: HttpPart<File>;
    },
  ): UploadResult;

  @route("/multi") @post multi(
    @multipartBody body: {
      label: HttpPart<string>;
      files: HttpPart<File>[];
    },
  ): UploadResult;

  @route("/optional") @post optional(
    @multipartBody body: {
      name: HttpPart<string>;
      description?: HttpPart<string>;
    },
  ): UploadResult;
}
`;

const inheritedBodyImportSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "InheritedBodyImportApi" })
namespace InheritedBodyImportApi;

model Payload {
  code: string;
}

model Base {
  payload: Payload;
}

model CreateRequest extends Base {
  name: string;
}

model CreateResponse {
  id: string;
}

@route("/items")
interface Items {
  @post create(@body body: CreateRequest): CreateResponse;
}
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("input decoding", () => {
  test("optional query and header params", () => {
    const r = compileFixture("params", paramsSpec);

    expect(r.readFile("params-api", "server-operations.ts")).toMatchSnapshot();
    expect(r.readFile("params-api", "server.ts")).toMatchSnapshot();
  });

  test("validation decorators become runtime validators", () => {
    const r = compileFixture("validations", validationSpec);

    expect(r.readFile("validation-api", "server-operations.ts")).toMatchSnapshot();
  });

  test("path + query + body combined", () => {
    const r = compileFixture("combined", combinedSpec);

    expect(r.readFile("combined-api", "server-operations.ts")).toMatchSnapshot();
  });

  test("cookie parameters", () => {
    const r = compileFixture("cookies", cookieSpec);

    expect(r.readFile("cookie-api", "server-operations.ts")).toMatchSnapshot();
    expect(r.readFile("cookie-api", "server.ts")).toMatchSnapshot();
  });

  test("recursive model uses Decoders.lazy", () => {
    const r = compileFixture("recursive", recursiveSpec);

    expect(r.readFile("tree-api", "server-operations.ts")).toMatchSnapshot();
  });

  test("multipart body with file, multi-valued, and optional parts", () => {
    const r = compileFixture("multipart", multipartSpec);

    expect(r.readFile("upload-api", "server-operations.ts")).toMatchSnapshot();
    expect(r.readFile("upload-api", "server.ts")).toMatchSnapshot();
  });

  test("inherited body properties pull in imported model types", () => {
    const r = compileFixture("inherited-body-import", inheritedBodyImportSpec);

    r.typecheck("inherited-body-import-api");
  });
});
