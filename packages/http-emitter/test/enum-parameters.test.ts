import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildEmitter, cleanupFixtures, compileFixture } from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const enumParameterSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service namespace EnumParameterApi;

enum Filter {
  active: "active",
  archived: "archived",
}

union Sort {
  ascending: "asc",
  descending: "desc",
}

@route("/items/{filter}")
@get
op read(
  @path filter: Filter,
  @query sort: Sort,
  @header("x-view") view: Filter,
  @cookie theme: Sort,
): void;
`;

describe("enum-valued HTTP parameters", () => {
  test("preserves precise decoder types in every request metadata location", async () => {
    const result = compileFixture("enum-parameters", enumParameterSpec);
    const operations = result.readFile("enum-parameter-api", "server-operations.ts");

    expect(operations).toContain(
      'Decoders.union([Decoders.literal("active"), Decoders.literal("archived")])',
    );
    expect(operations).toContain(
      'Decoders.union<Sort>([Decoders.literal("asc"), Decoders.literal("desc")])',
    );
    result.typecheck("enum-parameter-api");

    const { createEnumParameterApiServerRouter } = await import(
      `${result.outputDir}/enum-parameter-api/server-router.ts`
    );
    let received: unknown;
    const router = createEnumParameterApiServerRouter({
      read(input: unknown) {
        received = input;
      },
    } as any);

    const response = await router.handle(
      new Request("http://localhost/items/active?sort=asc", {
        headers: { "x-view": "archived", cookie: "theme=desc" },
      }),
    );

    expect(response.status).toBe(204);
    expect(received).toEqual({
      filter: "active",
      sort: "asc",
      view: "archived",
      theme: "desc",
    });

    const invalid = await router.handle(
      new Request("http://localhost/items/missing?sort=asc", {
        headers: { "x-view": "archived", cookie: "theme=desc" },
      }),
    );
    expect(invalid.status).toBe(400);
  });
});
