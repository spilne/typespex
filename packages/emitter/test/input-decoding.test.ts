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
});
