import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildEmitter,
  cleanupFixtures,
  compileFixture,
  compileFixtureExpectingDiagnostics,
} from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const distinguishableRoutesSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service namespace SharedRouteApi;

model JsonPayload {
  value: string;
}

@sharedRoute
@route("/ingest")
@post
op ingestJson(@body body: JsonPayload): void;

@sharedRoute
@route("/ingest")
@post
op ingestText(@header contentType: "text/plain", @body body: string): void;

@sharedRoute
@route("/reports/{reportId}")
@get
op detailed(
  @path reportId: string,
  @header("x-view") view: "detailed",
): void;

@sharedRoute
@route("/reports/{id}")
@get
op summary(
  @path id: string,
  @header("x-view") view: "summary",
): void;

@sharedRoute
@route("/caf%C3%A9")
@get
op encodedCafe(@header("x-form") form: "encoded"): void;

@sharedRoute
@route("/café")
@get
op unicodeCafe(@header("x-form") form: "unicode"): void;
`;

describe("shared HTTP routes", () => {
  test("dispatches by disjoint body media types and required literal headers", async () => {
    const result = compileFixture("shared-routes", distinguishableRoutesSpec);
    const operations = result.readFile("shared-route-api", "server-operations.ts");

    expect(operations).toMatch(
      /routeSelection:\s*\{\s*headers: \[\{ name: "content-type", values: \["application\/json"\], kind: "media-type" \}\],\s*\}/,
    );
    expect(operations).toMatch(
      /routeSelection:\s*\{\s*headers: \[\{ name: "content-type", values: \["text\/plain"\], kind: "media-type" \}\],\s*\}/,
    );
    expect(operations).toContain(
      'routeSelection: { headers: [{ name: "x-view", values: ["detailed"], kind: "exact" }] }',
    );
    result.typecheck("shared-route-api");

    const { createSharedRouteApiServerRouter } = await import(
      `${result.outputDir}/shared-route-api/server-router.ts`
    );
    const calls: string[] = [];
    const router = createSharedRouteApiServerRouter({
      ingestJson() {
        calls.push("json");
      },
      ingestText() {
        calls.push("text");
      },
      detailed(input: { reportId: string }) {
        calls.push(`detailed:${input.reportId}`);
      },
      summary(input: { id: string }) {
        calls.push(`summary:${input.id}`);
      },
      encodedCafe() {
        calls.push("encoded-cafe");
      },
      unicodeCafe() {
        calls.push("unicode-cafe");
      },
    } as any);

    const json = await router.handle(
      new Request("http://localhost/ingest", {
        method: "POST",
        headers: { "content-type": "Application/JSON; charset=utf-8" },
        body: JSON.stringify({ value: "structured" }),
      }),
    );
    const text = await router.handle(
      new Request("http://localhost/ingest", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "plain",
      }),
    );
    const summary = await router.handle(
      new Request("http://localhost/reports/r-1", { headers: { "x-view": "summary" } }),
    );
    const detailed = await router.handle(
      new Request("http://localhost/reports/r-2", { headers: { "x-view": "detailed" } }),
    );
    const encodedCafe = await router.handle(
      new Request("http://localhost/caf%C3%A9", { headers: { "x-form": "encoded" } }),
    );
    const unicodeCafe = await router.handle(
      new Request("http://localhost/café", { headers: { "x-form": "unicode" } }),
    );
    const unmatched = await router.handle(new Request("http://localhost/reports/r-3"));

    expect([
      json.status,
      text.status,
      summary.status,
      detailed.status,
      encodedCafe.status,
      unicodeCafe.status,
    ]).toEqual([204, 204, 204, 204, 204, 204]);
    expect(unmatched.status).toBe(404);
    expect(calls).toEqual([
      "json",
      "text",
      "summary:r-1",
      "detailed:r-2",
      "encoded-cafe",
      "unicode-cafe",
    ]);
  });

  test("rejects shared routes whose selectors overlap", () => {
    const result = compileFixtureExpectingDiagnostics(
      "ambiguous-shared-routes",
      `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace AmbiguousSharedApi;

        @sharedRoute @route("/reports") @get
        op summary(@header("x-view") view: "summary" | "detailed"): void;

        @sharedRoute @route("/reports") @get
        op detailed(@header("x-view") view: "detailed"): void;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("@typespex/emitter/ambiguous-shared-route");
    expect(diagnostics).toContain('Shared operations "AmbiguousSharedApi.summary"');
    expect(diagnostics).toContain('"AmbiguousSharedApi.detailed"');
    expect(diagnostics).toContain('"GET /reports"');
    expect(result.listFiles("ambiguous-shared-api")).toEqual([]);
  });

  test("rejects ordinary duplicate method/path routes with both operation names", () => {
    const result = compileFixtureExpectingDiagnostics(
      "duplicate-routes",
      `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace DuplicateRouteApi;

        @route("/items/{id}") @get op first(@path id: string): void;
        @route("/items/{itemId}") @get op second(@path itemId: string): void;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("@typespex/emitter/duplicate-route");
    expect(diagnostics).toContain('Operations "DuplicateRouteApi.first"');
    expect(diagnostics).toContain('"DuplicateRouteApi.second"');
    expect(diagnostics).toContain('"GET /items/{itemId}"');
    expect(result.listFiles("duplicate-route-api")).toEqual([]);
  });

  test("rejects collisions against either concrete optional path expansion", () => {
    const result = compileFixtureExpectingDiagnostics(
      "optional-path-collisions",
      `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace OptionalPathCollisionApi;

        @route("/items{/name}") @get op optional(@path name?: string): void;
        @route("/items") @get op list(): void;
        @route("/items/{id}") @get op read(@path id: string): void;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("@typespex/emitter/duplicate-route");
    expect(diagnostics).toContain("OptionalPathCollisionApi.optional");
    expect(diagnostics).toContain("OptionalPathCollisionApi.list");
    expect(diagnostics).toContain("OptionalPathCollisionApi.read");
    expect(result.listFiles("optional-path-collision-api")).toEqual([]);
  });

  test("rejects collisions against required slash path expansions", () => {
    const result = compileFixtureExpectingDiagnostics(
      "required-slash-path-collision",
      `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace RequiredSlashPathCollisionApi;

        @route("/items{/name}") @get op slash(@path name: string): void;
        @route("/items/{id}") @get op simple(@path id: string): void;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("@typespex/emitter/duplicate-route");
    expect(diagnostics).toContain("RequiredSlashPathCollisionApi.slash");
    expect(diagnostics).toContain("RequiredSlashPathCollisionApi.simple");
    expect(result.listFiles("required-slash-path-collision-api")).toEqual([]);
  });

  test("rejects collisions against exploded scalar simple expansions", () => {
    const result = compileFixtureExpectingDiagnostics(
      "exploded-simple-path-collision",
      `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace ExplodedSimplePathCollisionApi;

        @route("/items/{name*}") @get op exploded(@path name: string): void;
        @route("/items/{id}") @get op simple(@path id: string): void;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("@typespex/emitter/duplicate-route");
    expect(diagnostics).toContain("ExplodedSimplePathCollisionApi.exploded");
    expect(diagnostics).toContain("ExplodedSimplePathCollisionApi.simple");
    expect(result.listFiles("exploded-simple-path-collision-api")).toEqual([]);
  });

  test("rejects collisions against exploded simple array expansions", () => {
    const result = compileFixtureExpectingDiagnostics(
      "exploded-simple-array-path-collision",
      `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace ExplodedSimpleArrayPathCollisionApi;

        @route("/items{name*}") @get op exploded(@path name: string[]): void;
        @route("/items{id}") @get op simple(@path id: string): void;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("@typespex/emitter/duplicate-route");
    expect(diagnostics).toContain("ExplodedSimpleArrayPathCollisionApi.exploded");
    expect(diagnostics).toContain("ExplodedSimpleArrayPathCollisionApi.simple");
    expect(result.listFiles("exploded-simple-array-path-collision-api")).toEqual([]);
  });

  test("rejects collisions against scalar label expansions", () => {
    const result = compileFixtureExpectingDiagnostics(
      "scalar-label-path-collision",
      `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace ScalarLabelPathCollisionApi;

        @route("/items{.name}") @get op label(@path name: string): void;
        @route("/items.{id}") @get op simple(@path id: string): void;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("@typespex/emitter/duplicate-route");
    expect(diagnostics).toContain("ScalarLabelPathCollisionApi.label");
    expect(diagnostics).toContain("ScalarLabelPathCollisionApi.simple");
    expect(result.listFiles("scalar-label-path-collision-api")).toEqual([]);
  });

  test("rejects collisions against scalar matrix expansions", () => {
    const result = compileFixtureExpectingDiagnostics(
      "scalar-matrix-path-collision",
      `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace ScalarMatrixPathCollisionApi;

        @route("/items{;name}") @get op matrix(@path name: string): void;
        @route("/items;name={id}") @get op simple(@path id: string): void;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("@typespex/emitter/duplicate-route");
    expect(diagnostics).toContain("ScalarMatrixPathCollisionApi.matrix");
    expect(diagnostics).toContain("ScalarMatrixPathCollisionApi.simple");
    expect(result.listFiles("scalar-matrix-path-collision-api")).toEqual([]);
  });

  test("does not treat constraints on different headers as mutually exclusive", () => {
    const result = compileFixtureExpectingDiagnostics(
      "different-header-shared-routes",
      `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace DifferentHeaderApi;

        @sharedRoute @route("/items") @get
        op byMode(@header("x-mode") mode: "compact"): void;

        @sharedRoute @route("/items") @get
        op byVersion(@header("x-version") version: "2"): void;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("@typespex/emitter/ambiguous-shared-route");
    expect(diagnostics).toContain("DifferentHeaderApi.byMode");
    expect(diagnostics).toContain("DifferentHeaderApi.byVersion");
  });
});
