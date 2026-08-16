import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildEmitter,
  cleanupFixtures,
  compileFixture,
  compileFixtureExpectingDiagnostics,
} from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const collisionSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "RequestCollisionApi" })
namespace RequestCollisionApi;

model Payload {
  id: string;
  value: string;
}

@route("/path/{id}")
@post
op pathCollision(@path id: string, @body payload: Payload): void;

@route("/query")
@post
op queryCollision(@query id: string, @body payload: Payload): void;

@route("/header")
@post
op headerCollision(@header("x-id") id: string, @body payload: Payload): void;

@route("/cookie")
@post
op cookieCollision(@cookie id: string, @body payload: Payload): void;

@route("/optional/{id}")
@post
op optionalCollision(@path id: string, @body payload?: Payload): void;

@route("/allocated")
@post
op allocatedWrapper(
  @query body: string,
  @query body_2: string,
  @body payload: {
    body: string;
    value: string;
  },
): void;

@route("/clean")
@post
op nonColliding(@query trace: string, @body payload: Payload): void;

@route("/multipart")
@post
op multipartCollision(
  @query id: string,
  @multipartBody payload: {
    id: HttpPart<string>;
    note: HttpPart<string>;
  },
): void;

@route("/local-names")
@get
op localNames(
  @query v1: string,
  @query("dash-name") \`dash-name\`: string,
): void;
`;

const duplicateRequestPropertySpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "DuplicateRequestPropertyApi" })
namespace DuplicateRequestPropertyApi;

model NestedMetadata {
  @header("x-id") id: string;
  value: string;
}

model Payload {
  nested: NestedMetadata;
}

@route("/items/{id}")
@post
op create(@path id: string, @bodyRoot payload: Payload): void;
`;

function jsonRequest(
  path: string,
  body: unknown,
  options: { headers?: Record<string, string> } = {},
): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...options.headers },
    body: JSON.stringify(body),
  });
}

describe("request input property collisions", () => {
  test("wraps only colliding bodies and preserves every wire value", async () => {
    const result = compileFixture("request-input-collisions", collisionSpec);
    const server = result.readFile("request-collision-api", "server.ts");
    const operations = result.readFile("request-collision-api", "server-operations.ts");

    for (const operation of [
      "pathCollision",
      "queryCollision",
      "headerCollision",
      "cookieCollision",
    ]) {
      expect(server).toContain(
        `readonly ${operation}: OperationHandler<{ id: string; body: Payload }, void, Ctx>`,
      );
    }
    expect(server).toContain(
      "readonly optionalCollision: OperationHandler<{ id: string; body?: Payload }, void, Ctx>",
    );
    expect(server).toContain(
      "{ body: string; body_2: string; body_3: { body: string; value: string } }",
    );
    expect(server).toContain(
      "readonly nonColliding: OperationHandler<{ trace: string; id: string; value: string }, void, Ctx>",
    );
    expect(server).toContain(
      "readonly multipartCollision: OperationHandler<\n    { id: string; body: { id: string; note: string } },",
    );
    expect(operations).toMatch(/\.map\(\(body\) => \(\{\s*body,?\s*\}\)\)/);
    expect(operations).toContain(".map((body) => ({ body_3: body }))");
    expect(operations).toContain('(v1, v1_2) => ({ v1, "dash-name": v1_2 })');
    expect(operations).not.toContain("{ trace: string; body: Payload }");
    result.typecheck("request-collision-api");

    const { createRequestCollisionApiServerRouter } = await import(
      `${result.outputDir}/request-collision-api/server-router.ts`
    );
    const received = new Map<string, unknown[]>();
    const capture = (operation: string) => (input: unknown) => {
      const calls = received.get(operation) ?? [];
      calls.push(input);
      received.set(operation, calls);
    };
    const router = createRequestCollisionApiServerRouter({
      pathCollision: capture("pathCollision"),
      queryCollision: capture("queryCollision"),
      headerCollision: capture("headerCollision"),
      cookieCollision: capture("cookieCollision"),
      optionalCollision: capture("optionalCollision"),
      allocatedWrapper: capture("allocatedWrapper"),
      nonColliding: capture("nonColliding"),
      multipartCollision: capture("multipartCollision"),
      localNames: capture("localNames"),
    } as any);

    expect(
      (await router.handle(jsonRequest("/path/path-id", { id: "body-id", value: "path-payload" })))
        .status,
    ).toBe(204);
    expect(received.get("pathCollision")).toEqual([
      {
        id: "path-id",
        body: { id: "body-id", value: "path-payload" },
      },
    ]);

    expect(
      (
        await router.handle(
          jsonRequest("/query?id=query-id", { id: "body-id", value: "query-payload" }),
        )
      ).status,
    ).toBe(204);
    expect(received.get("queryCollision")).toEqual([
      {
        id: "query-id",
        body: { id: "body-id", value: "query-payload" },
      },
    ]);

    expect(
      (
        await router.handle(
          jsonRequest(
            "/header",
            { id: "body-id", value: "header-payload" },
            { headers: { "x-id": "header-id" } },
          ),
        )
      ).status,
    ).toBe(204);
    expect(received.get("headerCollision")).toEqual([
      {
        id: "header-id",
        body: { id: "body-id", value: "header-payload" },
      },
    ]);

    expect(
      (
        await router.handle(
          jsonRequest(
            "/cookie",
            { id: "body-id", value: "cookie-payload" },
            { headers: { cookie: "id=cookie-id" } },
          ),
        )
      ).status,
    ).toBe(204);
    expect(received.get("cookieCollision")).toEqual([
      {
        id: "cookie-id",
        body: { id: "body-id", value: "cookie-payload" },
      },
    ]);

    const absentOptional = await router.handle(
      new Request("http://localhost/optional/path-only", { method: "POST" }),
    );
    expect(absentOptional.status).toBe(204);
    expect(
      (
        await router.handle(
          jsonRequest("/optional/path-with-body", {
            id: "body-id",
            value: "optional-payload",
          }),
        )
      ).status,
    ).toBe(204);
    expect(received.get("optionalCollision")).toEqual([
      { id: "path-only" },
      {
        id: "path-with-body",
        body: { id: "body-id", value: "optional-payload" },
      },
    ]);

    expect(
      (
        await router.handle(
          jsonRequest("/allocated?body=outer&body_2=outer-2", {
            body: "inner",
            value: "allocated-payload",
          }),
        )
      ).status,
    ).toBe(204);
    expect(received.get("allocatedWrapper")).toEqual([
      {
        body: "outer",
        body_2: "outer-2",
        body_3: { body: "inner", value: "allocated-payload" },
      },
    ]);

    expect(
      (
        await router.handle(
          jsonRequest("/clean?trace=trace-id", {
            id: "body-id",
            value: "flat-payload",
          }),
        )
      ).status,
    ).toBe(204);
    expect(received.get("nonColliding")).toEqual([
      {
        trace: "trace-id",
        id: "body-id",
        value: "flat-payload",
      },
    ]);

    const form = new FormData();
    form.set("id", "multipart-body-id");
    form.set("note", "multipart-note");
    const multipartResponse = await router.handle(
      new Request("http://localhost/multipart?id=query-id", {
        method: "POST",
        body: form,
      }),
    );
    expect(multipartResponse.status).toBe(204);
    expect(received.get("multipartCollision")).toEqual([
      {
        id: "query-id",
        body: { id: "multipart-body-id", note: "multipart-note" },
      },
    ]);

    expect(
      (await router.handle(new Request("http://localhost/local-names?v1=first&dash-name=second")))
        .status,
    ).toBe(204);
    expect(received.get("localNames")).toEqual([{ v1: "first", "dash-name": "second" }]);
  });

  test("fails before emission when request locations share a handler property", () => {
    const result = compileFixtureExpectingDiagnostics(
      "duplicate-request-property",
      duplicateRequestPropertySpec,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("@typespex/http-emitter/request-input-property-collision");
    expect(diagnostics).toContain(
      'multiple HTTP inputs (path, header) that resolve to handler property "id"',
    );
    expect(result.listFiles("duplicate-request-property-api")).toEqual([]);
  });
});
