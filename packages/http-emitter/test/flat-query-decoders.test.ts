import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import {
  Decoders,
  RequestDecoders,
  Validators,
  decodeRequestInput,
} from "../../http-server/src/index.js";
import { buildEmitter, cleanupFixtures, compileFixture } from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter, 120_000);

test("flat query decoders agree with the generic decoders on every input", async () => {
  const result = compileFixture(
    "flat-query",
    `
    import "@typespec/http";
    using TypeSpec.Http;
    @service namespace FlatQueryApi;
    interface Items {
      @route("/items") @get list(
        @minValue(1) @maxValue(100) @query limit?: int32,
        @minValue(0) @query offset?: int32,
        @minLength(1) @maxLength(5) @pattern("^[a-z]", "Lowercase.") @query tag?: string,
        @query ratio?: float64,
        @query("include-all") includeAll?: boolean,
        @query kind: string,
      ): void;
      @route("/encoded") @get encoded(@query values?: string[], @query id?: safeint): void;
    }
  `,
  );
  result.typecheck("flat-query-api");
  const source = result.readFile("flat-query-api", "server-operations.ts");
  expect(source).toContain("const raw = input.rawQuery;");
  expect(source).toContain('length === 11 && raw.startsWith("include-all", start)');
  expect(source).toContain('raw.indexOf("include-all")');
  // Array inputs keep the generic decoders.
  expect(source).toMatch(/encoded: RequestDecoders\.combine\(/);
  appendFileSync(
    `${result.outputDir}/flat-query-api/server-operations.ts`,
    "\nexport { ItemsInput };\n",
  );
  const { ItemsInput } = await import(`${result.outputDir}/flat-query-api/server-operations.ts`);
  const actual = ItemsInput.list;
  const int32 = (extra: readonly Parameters<typeof Decoders.integer.validate>[number][]) =>
    Decoders.integer
      .validate(Validators.minValue(-2147483648), Validators.maxValue(2147483647))
      .validate(...extra);
  const expected = RequestDecoders.combine(
    [
      RequestDecoders.query(
        "limit",
        int32([Validators.minValue(1), Validators.maxValue(100)]).optional(),
      ),
      RequestDecoders.query("offset", int32([Validators.minValue(0)]).optional()),
      RequestDecoders.query(
        "tag",
        Decoders.string
          .validate(
            Validators.minLength(1),
            Validators.maxLength(5),
            Validators.pattern("^[a-z]", "Lowercase."),
          )
          .optional(),
      ),
      RequestDecoders.query("ratio", Decoders.number.optional()),
      RequestDecoders.query("include-all", Decoders.boolean.optional()),
      RequestDecoders.query("kind", Decoders.string),
    ],
    (limit, offset, tag, ratio, includeAll, kind) => ({
      limit,
      offset,
      tag,
      ratio,
      includeAll,
      kind,
    }),
  );

  const queries = [
    "",
    "?",
    "?kind=a",
    "?kind=a&limit=10",
    "?limit=10&kind=a&offset=2",
    "?kind=a&limit=1e1",
    "?kind=a&limit=10.0",
    "?kind=a&limit=-0",
    "?kind=a&limit=abc",
    "?kind=a&limit=",
    "?kind=a&limit",
    "?kind=a&limit=0",
    "?kind=a&limit=101",
    "?kind=a&limit=10&limit=11",
    "?kind=a&li%6Dit=10",
    "?kind=a&limit=1%30",
    "?kind=a&limit=+10",
    "?kind=a&limit=99999999999999999999",
    "?kind=a&offset=-1",
    "?kind=a&tag=abc",
    "?kind=a&tag=Abc",
    "?kind=a&tag=abcdef",
    "?kind=a&tag=",
    "?kind=a&tag=a+b",
    "?kind=a&tag=%61bc",
    "?kind=a&ratio=1.5",
    "?kind=a&ratio=1e400",
    "?kind=a&ratio=.5",
    "?kind=a&include-all=true",
    "?kind=a&include-all=false",
    "?kind=a&include-all=TRUE",
    "?kind=a&include-all=1",
    "?kind=a%26b",
    "?kind=",
    "?kind",
    "?kind=a&kind=b",
    "?unused=1&kind=a&other=2&limit=3",
    "?kind=a&&limit=5",
    "?=a&kind=b",
    "?kind=a#limit=5",
    "?kind=a&limit=5&" + Array.from({ length: 29 }, (_, i) => `u${i}=${i}`).join("&"),
    "?xlimit=5&kind=a",
    "?limit2=5&kind=a",
    "?kind=limit=5",
    "?limit&kind=a",
    "?kind=a&limit",
    "?limitx&limit=5&kind=a",
    "?limit=5&limit&kind=a",
    "?kind=a&offset=1&limit=5&offset=2",
    "?tag=abc&kind=a&tag=abd",
    "?include-all&kind=a",
    "?kind=a&include-all=",
    "?limit=5&kind=a&" + Array.from({ length: 29 }, (_, i) => `u${i}=%${i}`).join("&"),
  ];
  for (const query of queries) {
    const request = new Request(`http://localhost/items${query}`);
    expect(decodeRequestInput(actual, request, {})).toEqual(
      decodeRequestInput(expected, request, {}),
    );
  }
});
