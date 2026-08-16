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

const implicitAndRangedErrorStatusSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "WildcardStatusApi" })
namespace WildcardStatusApi;

model NoContent {
  @statusCode _: 204;
}

@error
model RangedFailure {
  @minValue(494)
  @maxValue(499)
  @statusCode
  status: int32;

  code: string;
  message: string;
}

@error
model DefaultFailure {
  code: string;
  message: string;
}

@route("/failure")
@get
op fail(): NoContent | RangedFailure | DefaultFailure;

@route("/default")
@get
op fallback(): DefaultFailure;
`;

const explicitWildcardStatusSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "ExplicitWildcardStatusApi" })
namespace ExplicitWildcardStatusApi;

@error
model Failure {
  @statusCode status: "*";
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

const canonicalNoContentErrorSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "CanonicalNoContentUnionApi" })
namespace CanonicalNoContentUnionApi;

@error
model InvalidAuth {
  @statusCode _: 403;
  error: string;
}

@route("/authenticate")
@get
op authenticate(): NoContentResponse | InvalidAuth;
`;

const optionalResponseMarkerCollisionSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "OptionalResponseMarkerCollisionApi" })
namespace OptionalResponseMarkerCollisionApi;

model Success {
  @statusCode _: 200;
  marker: string;
}

@error
model Failure {
  @statusCode _: 400;
  marker?: string;
  error: string;
}

@get
op choose(): Success | Failure;
`;

const openResponseMarkerCollisionSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "OpenResponseMarkerCollisionApi" })
namespace OpenResponseMarkerCollisionApi;

model Success {
  @statusCode _: 200;
  marker: string;
}

@error
model Failure {
  @statusCode _: 400;
  error: string;
  ...Record<unknown>;
}

@get
op choose(): Success | Failure;
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

  test("dispatches canonical no-content and modeled error responses", async () => {
    const result = compileFixture("canonical-no-content-error", canonicalNoContentErrorSpec);
    const operations = result.readFile("canonical-no-content-union-api", "server-operations.ts");

    expect(operations).toContain("ResponseEncoders.matchVariant<");
    expect(operations).toContain("Reflect.ownKeys(result).length === 0");
    expect(operations).toContain('"error" in result');
    expect(operations.indexOf('"error" in result')).toBeLessThan(
      operations.indexOf("Reflect.ownKeys(result).length === 0"),
    );
    result.typecheck("canonical-no-content-union-api");

    let handlerResult: Record<string, never> | { error: string } = {};
    const { createCanonicalNoContentUnionApiServerRouter } = await import(
      `${result.outputDir}/canonical-no-content-union-api/server-router.ts`
    );
    const router = createCanonicalNoContentUnionApiServerRouter({
      authenticate: () => handlerResult,
    });

    const accepted = await router.handle(new Request("http://localhost/authenticate"));
    expect(accepted.status).toBe(204);
    expect(accepted.headers.get("content-type")).toBeNull();
    expect(await accepted.text()).toBe("");

    handlerResult = { error: "invalid credentials" };
    const rejected = await router.handle(new Request("http://localhost/authenticate"));
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("content-type")).toBe("application/json");
    expect(await rejected.json()).toEqual({ error: "invalid credentials" });
  });

  test("rejects required response markers admitted by competing shapes", () => {
    for (const [name, spec, serviceDir] of [
      [
        "optional-response-marker-collision",
        optionalResponseMarkerCollisionSpec,
        "optional-response-marker-collision-api",
      ],
      [
        "open-response-marker-collision",
        openResponseMarkerCollisionSpec,
        "open-response-marker-collision-api",
      ],
    ] as const) {
      const result = compileFixtureExpectingDiagnostics(name, spec);
      const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

      expect(diagnostics).toContain("undifferentiable-response-union");
      expect(result.listFiles(serviceDir)).toEqual([]);
    }
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

  test("encodes implicit errors alongside ranged statuses", async () => {
    const result = compileFixture("response-status-wildcard", implicitAndRangedErrorStatusSpec);
    const operations = result.readFile("wildcard-status-api", "server-operations.ts");

    expect(operations).toContain(
      'status: { property: "status", allowed: [{ start: 494, end: 499 }] }',
    );
    expect(operations).toMatch(/status: 500[, }]/);
    expect(operations).toContain("fallback: ResponseEncoders.json<DefaultFailure>(500)");
    result.typecheck("wildcard-status-api");

    let handlerResult:
      | Record<string, never>
      | { status: number; code: string; message: string }
      | { code: string; message: string } = {
      status: 494,
      code: "request-header-too-large",
      message: "Request header too large",
    };
    const { createWildcardStatusApiServerRouter } = await import(
      `${result.outputDir}/wildcard-status-api/server-router.ts`
    );
    const router = createWildcardStatusApiServerRouter({
      fail: () => handlerResult,
      fallback: () => ({ code: "standalone", message: "Standalone failure" }),
    } as any);

    const ranged = await router.handle(new Request("http://localhost/failure"));
    expect(ranged.status).toBe(494);
    expect(await ranged.json()).toEqual({
      code: "request-header-too-large",
      message: "Request header too large",
    });

    handlerResult = { status: 493, code: "invalid", message: "Outside the declared range" };
    const invalidRange = await router.handle(new Request("http://localhost/failure"));
    expect(invalidRange.status).toBe(500);
    expect(await invalidRange.text()).toBe("Internal Server Error");

    handlerResult = { code: "unexpected", message: "Unexpected failure" };
    const fallback = await router.handle(new Request("http://localhost/failure"));
    expect(fallback.status).toBe(500);
    expect(await fallback.json()).toEqual({
      code: "unexpected",
      message: "Unexpected failure",
    });

    const standalone = await router.handle(new Request("http://localhost/default"));
    expect(standalone.status).toBe(500);
    expect(await standalone.json()).toEqual({
      code: "standalone",
      message: "Standalone failure",
    });
  });

  test("rejects explicit wildcard and Fetch-incompatible status contracts before emission", () => {
    const wildcard = compileFixtureExpectingDiagnostics(
      "response-status-explicit-wildcard",
      explicitWildcardStatusSpec,
    );
    const wildcardDiagnostics = `${wildcard.diagnostics.stdout}\n${wildcard.diagnostics.stderr}`;
    expect(wildcardDiagnostics).toContain("status-code-invalid");
    expect(wildcard.listFiles("explicit-wildcard-status-api")).toEqual([]);

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
