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

  test("rejects collisions against standard slash array expansions", () => {
    const result = compileFixtureExpectingDiagnostics(
      "standard-slash-array-path-collision",
      `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace StandardSlashArrayPathCollisionApi;

        @route("/items{/names}") @get op slash(@path names: string[]): void;
        @route("/items/{id}") @get op simple(@path id: string): void;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("@typespex/emitter/duplicate-route");
    expect(diagnostics).toContain("StandardSlashArrayPathCollisionApi.slash");
    expect(diagnostics).toContain("StandardSlashArrayPathCollisionApi.simple");
    expect(result.listFiles("standard-slash-array-path-collision-api")).toEqual([]);
  });

  test("rejects collisions against standard slash record expansions", () => {
    const result = compileFixtureExpectingDiagnostics(
      "standard-slash-record-path-collision",
      `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace StandardSlashRecordPathCollisionApi;

        @route("/items{/values}") @get op slash(@path values: Record<int32>): void;
        @route("/items/{id}") @get op simple(@path id: string): void;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("@typespex/emitter/duplicate-route");
    expect(diagnostics).toContain("StandardSlashRecordPathCollisionApi.slash");
    expect(diagnostics).toContain("StandardSlashRecordPathCollisionApi.simple");
    expect(result.listFiles("standard-slash-record-path-collision-api")).toEqual([]);
  });

  test("rejects structurally duplicate exploded slash array expansions", () => {
    const result = compileFixtureExpectingDiagnostics(
      "exploded-slash-array-path-collision",
      `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace ExplodedSlashArrayPathCollisionApi;

        @route("/items{/names*}") @get op first(@path names: string[]): void;
        @route("/items{/values*}") @get op second(@path values: string[]): void;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("@typespex/emitter/duplicate-route");
    expect(diagnostics).toContain("ExplodedSlashArrayPathCollisionApi.first");
    expect(diagnostics).toContain("ExplodedSlashArrayPathCollisionApi.second");
    expect(result.listFiles("exploded-slash-array-path-collision-api")).toEqual([]);
  });

  test("rejects structurally duplicate exploded slash record expansions", () => {
    const result = compileFixtureExpectingDiagnostics(
      "exploded-slash-record-path-collision",
      `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace ExplodedSlashRecordPathCollisionApi;

        @route("/items{/first*}") @get op first(@path first: Record<int32>): void;
        @route("/items{/second*}") @get op second(@path second: Record<int32>): void;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("@typespex/emitter/duplicate-route");
    expect(diagnostics).toContain("ExplodedSlashRecordPathCollisionApi.first");
    expect(diagnostics).toContain("ExplodedSlashRecordPathCollisionApi.second");
    expect(result.listFiles("exploded-slash-record-path-collision-api")).toEqual([]);
  });

  test("rejects structurally duplicate reserved path expansions", () => {
    const result = compileFixtureExpectingDiagnostics(
      "reserved-path-collision",
      `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace ReservedPathCollisionApi;

        @route("/items/{+name}") @get op first(@path name: string): void;
        @route("/items/{+value}") @get op second(@path value: string): void;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("@typespex/emitter/duplicate-route");
    expect(diagnostics).toContain("ReservedPathCollisionApi.first");
    expect(diagnostics).toContain("ReservedPathCollisionApi.second");
    expect(result.listFiles("reserved-path-collision-api")).toEqual([]);
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

  test("rejects collisions against exploded simple record expansions", () => {
    const result = compileFixtureExpectingDiagnostics(
      "exploded-simple-record-path-collision",
      `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace ExplodedSimpleRecordPathCollisionApi;

        @route("/items{values*}") @get op exploded(@path values: Record<int32>): void;
        @route("/items{id}") @get op simple(@path id: string): void;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("@typespex/emitter/duplicate-route");
    expect(diagnostics).toContain("ExplodedSimpleRecordPathCollisionApi.exploded");
    expect(diagnostics).toContain("ExplodedSimpleRecordPathCollisionApi.simple");
    expect(result.listFiles("exploded-simple-record-path-collision-api")).toEqual([]);
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

  test("rejects collisions against standard label array expansions", () => {
    const result = compileFixtureExpectingDiagnostics(
      "standard-label-array-path-collision",
      `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace StandardLabelArrayPathCollisionApi;

        @route("/items{.name}") @get op label(@path name: string[]): void;
        @route("/items.{id}") @get op simple(@path id: string): void;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("@typespex/emitter/duplicate-route");
    expect(diagnostics).toContain("StandardLabelArrayPathCollisionApi.label");
    expect(diagnostics).toContain("StandardLabelArrayPathCollisionApi.simple");
    expect(result.listFiles("standard-label-array-path-collision-api")).toEqual([]);
  });

  test("rejects collisions against standard label record expansions", () => {
    const result = compileFixtureExpectingDiagnostics(
      "standard-label-record-path-collision",
      `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace StandardLabelRecordPathCollisionApi;

        @route("/items{.values}") @get op label(@path values: Record<int32>): void;
        @route("/items.{id}") @get op simple(@path id: string): void;
        @route("/items") @get op empty(): void;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("@typespex/emitter/duplicate-route");
    expect(diagnostics).toContain("StandardLabelRecordPathCollisionApi.label");
    expect(diagnostics).toContain("StandardLabelRecordPathCollisionApi.simple");
    expect(diagnostics).toContain("StandardLabelRecordPathCollisionApi.empty");
    expect(result.listFiles("standard-label-record-path-collision-api")).toEqual([]);
  });

  test("rejects collisions against exploded label record expansions", () => {
    const result = compileFixtureExpectingDiagnostics(
      "exploded-label-record-path-collision",
      `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace ExplodedLabelRecordPathCollisionApi;

        @route("/items{.values*}") @get op label(@path values: Record<int32>): void;
        @route("/items.{id}") @get op simple(@path id: string): void;
        @route("/items") @get op empty(): void;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("@typespex/emitter/duplicate-route");
    expect(diagnostics).toContain("ExplodedLabelRecordPathCollisionApi.label");
    expect(diagnostics).toContain("ExplodedLabelRecordPathCollisionApi.simple");
    expect(diagnostics).toContain("ExplodedLabelRecordPathCollisionApi.empty");
    expect(result.listFiles("exploded-label-record-path-collision-api")).toEqual([]);
  });

  test("rejects collisions against exploded label array expansions", () => {
    const result = compileFixtureExpectingDiagnostics(
      "exploded-label-array-path-collision",
      `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace ExplodedLabelArrayPathCollisionApi;

        @route("/items{.name*}") @get op label(@path name: string[]): void;
        @route("/items.{id}") @get op simple(@path id: string): void;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("@typespex/emitter/duplicate-route");
    expect(diagnostics).toContain("ExplodedLabelArrayPathCollisionApi.label");
    expect(diagnostics).toContain("ExplodedLabelArrayPathCollisionApi.simple");
    expect(result.listFiles("exploded-label-array-path-collision-api")).toEqual([]);
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

  test("rejects collisions against standard matrix array expansions", () => {
    const result = compileFixtureExpectingDiagnostics(
      "standard-matrix-array-path-collision",
      `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace StandardMatrixArrayPathCollisionApi;

        @route("/items{;name}") @get op matrix(@path name: string[]): void;
        @route("/items;name={id}") @get op simple(@path id: string): void;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("@typespex/emitter/duplicate-route");
    expect(diagnostics).toContain("StandardMatrixArrayPathCollisionApi.matrix");
    expect(diagnostics).toContain("StandardMatrixArrayPathCollisionApi.simple");
    expect(result.listFiles("standard-matrix-array-path-collision-api")).toEqual([]);
  });

  test("rejects collisions against standard matrix record expansions", () => {
    const result = compileFixtureExpectingDiagnostics(
      "standard-matrix-record-path-collision",
      `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace StandardMatrixRecordPathCollisionApi;

        @route("/items{;values}") @get op matrix(@path values: Record<int32>): void;
        @route("/items;values={id}") @get op simple(@path id: string): void;
        @route("/items") @get op empty(): void;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("@typespex/emitter/duplicate-route");
    expect(diagnostics).toContain("StandardMatrixRecordPathCollisionApi.matrix");
    expect(diagnostics).toContain("StandardMatrixRecordPathCollisionApi.simple");
    expect(diagnostics).toContain("StandardMatrixRecordPathCollisionApi.empty");
    expect(result.listFiles("standard-matrix-record-path-collision-api")).toEqual([]);
  });

  test("rejects collisions against exploded matrix record expansions", () => {
    const result = compileFixtureExpectingDiagnostics(
      "exploded-matrix-record-path-collision",
      `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace ExplodedMatrixRecordPathCollisionApi;

        @route("/items{;values*}") @get op matrix(@path values: Record<int32>): void;
        @route("/items;{id}") @get op simple(@path id: string): void;
        @route("/items") @get op empty(): void;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("@typespex/emitter/duplicate-route");
    expect(diagnostics).toContain("ExplodedMatrixRecordPathCollisionApi.matrix");
    expect(diagnostics).toContain("ExplodedMatrixRecordPathCollisionApi.simple");
    expect(diagnostics).toContain("ExplodedMatrixRecordPathCollisionApi.empty");
    expect(result.listFiles("exploded-matrix-record-path-collision-api")).toEqual([]);
  });

  test("rejects collisions against exploded matrix array expansions", () => {
    const result = compileFixtureExpectingDiagnostics(
      "exploded-matrix-array-path-collision",
      `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace ExplodedMatrixArrayPathCollisionApi;

        @route("/items{;name*}") @get op matrix(@path name: string[]): void;
        @route("/items;name={id}") @get op simple(@path id: string): void;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("@typespex/emitter/duplicate-route");
    expect(diagnostics).toContain("ExplodedMatrixArrayPathCollisionApi.matrix");
    expect(diagnostics).toContain("ExplodedMatrixArrayPathCollisionApi.simple");
    expect(result.listFiles("exploded-matrix-array-path-collision-api")).toEqual([]);
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
