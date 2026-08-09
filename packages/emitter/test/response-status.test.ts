import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildEmitter,
  cleanupFixtures,
  compileFixture,
  compileFixtureExpectingDiagnostics,
} from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const responseStatusSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "ResponseStatusApi" })
namespace ResponseStatusApi;

model NoContent {
  @statusCode status: 204;
  @header etag: string;
}

model NotModified {
  @statusCode status: 304;
  @header etag: string;
}

model Created {
  @statusCode status: 201;
  @header contentType: "text/plain";
  @body body: string;
}

model AnySuccess {
  @statusCode
  @minValue(200)
  @maxValue(299)
  status: int32;

  @header contentType: "text/plain";
  @body body: string;
}

@error
model ClientFailure {
  @statusCode
  @minValue(400)
  @maxValue(499)
  status: int32;

  @header contentType: "text/plain";
  @body body: string;
}

model RedirectRange {
  @statusCode
  @minValue(300)
  @maxValue(399)
  status: int32;

  @header contentType: "text/plain";
  @body body: string;
}

model CreatedOrOk {
  @statusCode status: 200 | 201;
  @header contentType: "text/plain";
  @body body: string;
}

model DeclaredBodyAtNoContent {
  @statusCode status: 204;
  @header contentType: "text/plain";
  @body body: string;
}

model RootPayloadWithStatus {
  status: string;
  value: string;
}

model RootStatusCollision {
  @statusCode
  @minValue(200)
  @maxValue(299)
  status: int32;

  @bodyRoot payload: RootPayloadWithStatus;
}

model FixedRootStatusCollision {
  @statusCode status: 209;
  @bodyRoot payload: RootPayloadWithStatus;
}

model OptionalDynamicStatus {
  @statusCode
  @minValue(200)
  @maxValue(299)
  status?: int32;

  @body body: string;
}

model FixedOk {
  @statusCode status: 200;
  @body body: string;
}

model LaterSuccess {
  @statusCode
  @minValue(201)
  @maxValue(299)
  status: int32;

  @body body: string;
}

@route("/empty")
@get
op empty(): NoContent;

@route("/cached")
@get
op cached(): NotModified;

@route("/created")
@get
op created(): Created;

@route("/dynamic")
@get
op dynamic(): AnySuccess;

@route("/client-error")
@get
op clientError(): ClientFailure;

@route("/ranged-choice")
@get
op rangedChoice(): AnySuccess | RedirectRange;

@route("/status-union")
@get
op statusUnion(): CreatedOrOk;

@route("/declared-no-content")
@get
op declaredNoContent(): DeclaredBodyAtNoContent;

@route("/root-status-collision")
@get
op rootStatusCollision(): RootStatusCollision;

@route("/fixed-root-status-collision")
@get
op fixedRootStatusCollision(): FixedRootStatusCollision;

@route("/optional-dynamic-status")
@get
op optionalDynamicStatus(): OptionalDynamicStatus;

@route("/mixed-fixed-dynamic")
@get
op mixedFixedDynamic(): FixedOk | LaterSuccess;
`;

const wildcardStatusSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "WildcardStatusApi" })
namespace WildcardStatusApi;

@error
model Failure {
  message: string;
}

@get
op fail(): Failure;
`;

const informationalStatusSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "InformationalStatusApi" })
namespace InformationalStatusApi;

model ContinueResponse {
  @statusCode status: 100;
}

@get
op continueResponse(): ContinueResponse;
`;

const openStatusAmbiguitySpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "OpenStatusAmbiguityApi" })
namespace OpenStatusAmbiguityApi;

model FixedOpenResponse {
  @statusCode statusCode: 200;
  value: string;
  ...Record<unknown>;
}

model DynamicResponse {
  @statusCode
  @minValue(201)
  @maxValue(299)
  status: int32;

  @body body: string;
}

@get
op ambiguous(): FixedOpenResponse | DynamicResponse;
`;

const canonicalNoContentSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "CanonicalNoContentApi" })
namespace CanonicalNoContentApi;

model User {
  name: string;
}

@route("/users")
@put
op replace(@body user: User): NoContentResponse;
`;

describe("response status lowering", () => {
  test("inlines canonical HTTP response models without importing missing declarations", () => {
    const result = compileFixture("canonical-no-content", canonicalNoContentSpec);
    const models = result.readFile("canonical-no-content-api", "models.ts");
    const server = result.readFile("canonical-no-content-api", "server.ts");
    const operations = result.readFile("canonical-no-content-api", "server-operations.ts");

    expect(models).not.toContain("NoContentResponse");
    expect(server).toContain(
      "readonly replace: OperationHandler<User, Record<string, never>, Ctx>",
    );
    expect(operations).not.toContain("NoContentResponse");
    expect(operations).toMatch(/status: 204,\s*kind: "empty"/);
    result.typecheck("canonical-no-content-api");
  });

  test("preserves body absence and drives dynamic statuses from handler results", async () => {
    const result = compileFixture("response-status", responseStatusSpec);
    const server = result.readFile("response-status-api", "server.ts");
    const operations = result.readFile("response-status-api", "server-operations.ts");

    expect(server).toContain(
      "readonly empty: OperationHandler<Record<string, never>, { etag: string }, Ctx>",
    );
    expect(server).toContain(
      "readonly cached: OperationHandler<Record<string, never>, { etag: string }, Ctx>",
    );
    expect(server).toContain(
      "readonly dynamic: OperationHandler<Record<string, never>, { body: string; status: number }, Ctx>",
    );
    expect(server).toMatch(
      /readonly statusUnion: OperationHandler<\s*Record<string, never>,\s*\{ body: string; status: 200 \| 201 \},\s*Ctx\s*>/,
    );
    expect(server).toMatch(
      /readonly rootStatusCollision: OperationHandler<\s*Record<string, never>,\s*\{ payload: RootPayloadWithStatus; status: number \},\s*Ctx\s*>/,
    );
    expect(server).toMatch(
      /readonly fixedRootStatusCollision: OperationHandler<\s*Record<string, never>,\s*\{ payload: RootPayloadWithStatus \},\s*Ctx\s*>/,
    );
    expect(server).toMatch(
      /readonly optionalDynamicStatus: OperationHandler<\s*Record<string, never>,\s*\{ body: string; status: number \},\s*Ctx\s*>/,
    );
    expect(server).not.toContain("{ body: string; status?: number }");
    expect(server).toMatch(
      /readonly mixedFixedDynamic: OperationHandler<\s*Record<string, never>,\s*\{ body: string \} \| \{ body: string; status: number \},\s*Ctx\s*>/,
    );
    expect(operations).toMatch(/status: 204,\s*kind: "empty"/);
    expect(operations).toMatch(/status: 304,\s*kind: "empty"/);
    expect(operations).toContain(
      `status: { property: "status", allowed: [{ start: 200, end: 299 }] }`,
    );
    expect(operations).toContain(`status: { property: "status", allowed: [200, 201] }`);
    expect(operations).toContain(
      `statusUnion: ResponseEncoders.variant<{ body: string; status: 200 | 201 }>`,
    );
    expect(operations).toContain("ResponseEncoders.matchVariant<{ body: string; status: number }>");
    expect(operations).toContain(
      `status: { property: "status", allowed: [{ start: 300, end: 399 }] }`,
    );
    expect(operations).toContain(`body: "payload"`);
    expect(operations).toContain(`!Object.prototype.hasOwnProperty.call(result, "status")`);
    result.typecheck("response-status-api");

    let dynamicResult = { status: 206, body: "partial" };
    let mixedFixedDynamicResult: { body: string } | { status: number; body: string } = {
      body: "fixed",
    };
    const { createResponseStatusApiServerRouter } = await import(
      `${result.outputDir}/response-status-api/server-router.ts`
    );
    const router = createResponseStatusApiServerRouter({
      empty: () => ({ etag: '"empty"' }),
      cached: () => ({ etag: '"cached"' }),
      created: () => ({ body: "created" }),
      dynamic: () => dynamicResult,
      clientError: () => ({ status: 422, body: "invalid" }),
      rangedChoice: () => ({ status: 302, body: "redirect" }),
      statusUnion: () => ({ status: 201, body: "union-created" }),
      declaredNoContent: () => ({ body: "must-not-be-sent" }),
      rootStatusCollision: () => ({
        status: 207,
        payload: { status: "body-status", value: "kept" },
      }),
      fixedRootStatusCollision: () => ({
        payload: { status: "fixed-body-status", value: "also-kept" },
      }),
      optionalDynamicStatus: () => ({ status: 208, body: "required-by-handler" }),
      mixedFixedDynamic: () => mixedFixedDynamicResult,
    } as any);

    const empty = await router.handle(new Request("http://localhost/empty"));
    expect(empty.status).toBe(204);
    expect(empty.headers.get("etag")).toBe('"empty"');
    expect(empty.headers.get("content-type")).toBeNull();
    expect(await empty.text()).toBe("");

    const cached = await router.handle(new Request("http://localhost/cached"));
    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe('"cached"');
    expect(cached.headers.get("content-type")).toBeNull();
    expect(await cached.text()).toBe("");

    const created = await router.handle(new Request("http://localhost/created"));
    expect(created.status).toBe(201);
    expect(await created.text()).toBe("created");

    const dynamic = await router.handle(new Request("http://localhost/dynamic"));
    expect(dynamic.status).toBe(206);
    expect(await dynamic.text()).toBe("partial");

    dynamicResult = { status: 204, body: "must-not-be-sent" };
    const dynamicNoContent = await router.handle(new Request("http://localhost/dynamic"));
    expect(dynamicNoContent.status).toBe(204);
    expect(dynamicNoContent.headers.get("content-type")).toBeNull();
    expect(await dynamicNoContent.text()).toBe("");

    const clientError = await router.handle(new Request("http://localhost/client-error"));
    expect(clientError.status).toBe(422);
    expect(await clientError.text()).toBe("invalid");

    const rangedChoice = await router.handle(new Request("http://localhost/ranged-choice"));
    expect(rangedChoice.status).toBe(302);
    expect(await rangedChoice.text()).toBe("redirect");

    const statusUnion = await router.handle(new Request("http://localhost/status-union"));
    expect(statusUnion.status).toBe(201);
    expect(await statusUnion.text()).toBe("union-created");

    const declaredNoContent = await router.handle(
      new Request("http://localhost/declared-no-content"),
    );
    expect(declaredNoContent.status).toBe(204);
    expect(declaredNoContent.headers.get("content-type")).toBeNull();
    expect(await declaredNoContent.text()).toBe("");

    const rootCollision = await router.handle(
      new Request("http://localhost/root-status-collision"),
    );
    expect(rootCollision.status).toBe(207);
    expect(await rootCollision.json()).toEqual({
      status: "body-status",
      value: "kept",
    });

    const fixedRootCollision = await router.handle(
      new Request("http://localhost/fixed-root-status-collision"),
    );
    expect(fixedRootCollision.status).toBe(209);
    expect(await fixedRootCollision.json()).toEqual({
      status: "fixed-body-status",
      value: "also-kept",
    });

    const optionalStatus = await router.handle(
      new Request("http://localhost/optional-dynamic-status"),
    );
    expect(optionalStatus.status).toBe(208);
    expect(await optionalStatus.text()).toBe("required-by-handler");

    const fixed = await router.handle(new Request("http://localhost/mixed-fixed-dynamic"));
    expect(fixed.status).toBe(200);
    expect(await fixed.text()).toBe("fixed");

    mixedFixedDynamicResult = { status: 250, body: "dynamic" };
    const ranged = await router.handle(new Request("http://localhost/mixed-fixed-dynamic"));
    expect(ranged.status).toBe(250);
    expect(await ranged.text()).toBe("dynamic");

    mixedFixedDynamicResult = { status: 999, body: "must-not-fall-through" };
    const invalidDynamic = await router.handle(new Request("http://localhost/mixed-fixed-dynamic"));
    expect(invalidDynamic.status).toBe(500);
    expect(await invalidDynamic.text()).toBe("Internal Server Error");
  });

  test("rejects wildcard and Fetch-incompatible status contracts before emission", () => {
    const wildcard = compileFixtureExpectingDiagnostics(
      "response-status-wildcard",
      wildcardStatusSpec,
    );
    const wildcardDiagnostics = `${wildcard.diagnostics.stdout}\n${wildcard.diagnostics.stderr}`;
    expect(wildcardDiagnostics).toContain("unsupported-response-status-code");
    expect(wildcardDiagnostics).toContain('wildcard status "*"');
    expect(wildcard.listFiles("wildcard-status-api")).toEqual([]);

    const informational = compileFixtureExpectingDiagnostics(
      "response-status-informational",
      informationalStatusSpec,
    );
    const informationalDiagnostics = `${informational.diagnostics.stdout}\n${informational.diagnostics.stderr}`;
    expect(informationalDiagnostics).toContain("unsupported-response-status-code");
    expect(informationalDiagnostics).toContain("200–599");
    expect(informational.listFiles("informational-status-api")).toEqual([]);
  });

  test("rejects status dispatch that overlaps an open fixed-response body", () => {
    const result = compileFixtureExpectingDiagnostics(
      "response-status-open-ambiguity",
      openStatusAmbiguitySpec,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("undifferentiable-response-union");
    expect(result.listFiles("open-status-ambiguity-api")).toEqual([]);
  });
});
