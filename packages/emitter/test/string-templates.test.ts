import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildEmitter,
  cleanupFixtures,
  compileFixture,
  compileFixtureExpectingDiagnostics,
} from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const resolvedTemplateSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service namespace StringTemplateApi;

alias Prefix = "hello";
alias Greeting = "\${Prefix} world";
alias Detailed = "\${Prefix}-detailed";
alias Summary = "\${Prefix}-summary";

model Payload {
  greeting: Greeting;
}

model DetailedVariant {
  kind: Detailed;
  value: string;
}

model SummaryVariant {
  kind: Summary;
  value: string;
}

union Variant {
  detailed: DetailedVariant,
  summary: SummaryVariant,
}

model DetailedResponse {
  @statusCode status: 200;
  kind: Detailed;
  value: string;
}

model SummaryResponse {
  @statusCode status: 201;
  kind: Summary;
  value: string;
}

model TextResponse {
  @header contentType: "text/plain";
  @body body: Greeting;
}

@route("/payload")
@post
op payload(@body body: Payload): Payload;

@route("/query")
@get
op query(
  @query greeting: Greeting,
  @header("x-greeting") header: Greeting,
): void;

@route("/path/{value}")
@get
op path(@path value: Greeting): void;

@route("/variant")
@post
op variant(@body body: Variant): Variant;

@route("/response")
@get
op response(): DetailedResponse | SummaryResponse;

@route("/text")
@get
op text(): TextResponse;

@sharedRoute
@route("/shared")
@get
op detailed(@header("x-view") view: Detailed): void;

@sharedRoute
@route("/shared")
@get
op summary(@header("x-view") view: Summary): void;
`;

describe("TypeSpec string-template literals", () => {
  test("preserves resolved templates across types, requests, routing, and responses", async () => {
    const result = compileFixture("string-template-literals", resolvedTemplateSpec);
    const models = result.readFile("string-template-api", "models.ts");
    const server = result.readFile("string-template-api", "server.ts");
    const operations = result.readFile("string-template-api", "server-operations.ts");

    expect(models).toContain('greeting: "hello world";');
    expect(models).toContain('kind: "hello-detailed";');
    expect(server).toContain(
      'readonly text: OperationHandler<Record<string, never>, { body: "hello world" }, Ctx>',
    );
    expect(operations).toContain('Decoders.strictLiteral("hello world")');
    expect(operations).toContain('Decoders.literal("hello world")');
    expect(operations).toContain('=== "hello-detailed"');
    expect(operations).toMatch(
      /routeSelection:\s*\{\s*headers: \[\{ name: "x-view", values: \["hello-detailed"\], kind: "exact" \}\],\s*\}/,
    );

    result.typecheck("string-template-api", {
      "string-template-contract.ts": `
        import type { Payload } from "./models.js";
        const valid: Payload = { greeting: "hello world" };
        void valid;
        // @ts-expect-error Resolved templates remain exact string literals.
        const invalid: Payload = { greeting: "anything" };
        void invalid;
      `,
    });

    const { createStringTemplateApiServerRouter } = await import(
      `${result.outputDir}/string-template-api/server-router.ts`
    );
    const received = new Map<string, unknown>();
    const sharedCalls: string[] = [];
    const router = createStringTemplateApiServerRouter({
      payload(input: unknown) {
        received.set("payload", input);
        return input;
      },
      query(input: unknown) {
        received.set("query", input);
      },
      path(input: unknown) {
        received.set("path", input);
      },
      variant(input: unknown) {
        received.set("variant", input);
        return input;
      },
      response() {
        return { kind: "hello-detailed", value: "exact" };
      },
      text() {
        return { body: "hello world" };
      },
      detailed() {
        sharedCalls.push("detailed");
      },
      summary() {
        sharedCalls.push("summary");
      },
    } as any);

    const payload = await router.handle(
      new Request("http://localhost/payload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"greeting":"hello world"}',
      }),
    );
    expect(payload.status).toBe(200);
    expect(received.get("payload")).toEqual({ greeting: "hello world" });
    expect(await payload.json()).toEqual({ greeting: "hello world" });

    const invalidPayload = await router.handle(
      new Request("http://localhost/payload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"greeting":"anything"}',
      }),
    );
    expect(invalidPayload.status).toBe(400);

    const query = await router.handle(
      new Request("http://localhost/query?greeting=hello%20world", {
        headers: { "x-greeting": "hello world" },
      }),
    );
    expect(query.status).toBe(204);
    expect(received.get("query")).toEqual({
      greeting: "hello world",
      header: "hello world",
    });

    const path = await router.handle(new Request("http://localhost/path/hello%20world"));
    expect(path.status).toBe(204);
    expect(received.get("path")).toEqual({ value: "hello world" });
    expect((await router.handle(new Request("http://localhost/path/anything"))).status).toBe(400);

    const variant = await router.handle(
      new Request("http://localhost/variant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"kind":"hello-detailed","value":"exact"}',
      }),
    );
    expect(variant.status).toBe(200);
    expect(received.get("variant")).toEqual({ kind: "hello-detailed", value: "exact" });

    const response = await router.handle(new Request("http://localhost/response"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "hello-detailed", value: "exact" });

    const text = await router.handle(new Request("http://localhost/text"));
    expect(text.status).toBe(200);
    expect(text.headers.get("content-type")).toBe("text/plain");
    expect(await text.text()).toBe("hello world");

    expect(
      (
        await router.handle(
          new Request("http://localhost/shared", { headers: { "x-view": "hello-detailed" } }),
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await router.handle(
          new Request("http://localhost/shared", { headers: { "x-view": "hello-summary" } }),
        )
      ).status,
    ).toBe(204);
    expect(sharedCalls).toEqual(["detailed", "summary"]);
  });

  test("rejects templates that do not resolve to one exact string", () => {
    const result = compileFixtureExpectingDiagnostics(
      "unsupported-string-template",
      `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace UnsupportedStringTemplateApi;
        alias OpenTemplate = "item-\${string}";
        model Payload { value: OpenTemplate; }
        @post op create(@body body: Payload): Payload;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics.match(/@typespex\/emitter\/unsupported-string-template:/g)?.length).toBe(1);
    expect(diagnostics).toContain("does not resolve to one string");
    expect(result.listFiles("unsupported-string-template-api")).toEqual([]);
  });

  test("preflights unresolved templates used only as generic scalar arguments", () => {
    const result = compileFixtureExpectingDiagnostics(
      "unsupported-string-template-argument",
      `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace UnsupportedStringTemplateArgumentApi;
        alias OpenTemplate = "item-\${string}";
        scalar Wrapped<T extends string> extends string;
        @post op create(
          @body body: Wrapped<OpenTemplate>,
        ): Wrapped<OpenTemplate>;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics.match(/@typespex\/emitter\/unsupported-string-template:/g)?.length).toBe(1);
    expect(result.listFiles("unsupported-string-template-argument-api")).toEqual([]);
  });
});
