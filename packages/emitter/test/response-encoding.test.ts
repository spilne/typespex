import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildEmitter,
  cleanupFixtures,
  compileFixture,
  compileFixtureExpectingDiagnostics,
} from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const voidSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "VoidApi" })
namespace VoidApi;

@route("/items")
interface Items {
  @delete remove(@path itemId: string): void;
}
`;

const arraySpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "ArrayApi" })
namespace ArrayApi;

model Tag { name: string; count: int32; }

@route("/tags")
interface Tags {
  @get list(): Tag[];
  @post create(@body body: Tag): Tag;
}
`;

const enumSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "EnumApi" })
namespace EnumApi;

enum PetKind { Dog: "dog", Cat: "cat", Bird: "bird" }

model Pet { id: string; name: string; kind: PetKind; tag?: string; }

model NotFoundError {
  @header statusCode: 404;
  code: "NOT_FOUND";
  message: string;
}

@route("/pets")
interface Pets {
  @get read(@path petId: string): Pet | NotFoundError;
}
`;

const responseHeadersSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "HeadersApi" })
namespace HeadersApi;

model RateLimitedResponse {
  @header("x-rate-limit") rateLimit: int32;
  @header("x-request-id") requestId: string;
  data: string;
}

@route("/data")
interface Data {
  @get fetch(): RateLimitedResponse;
}
`;

const contentTypeSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "ContentApi" })
namespace ContentApi;

@route("/text")
interface Text {
  @get plain(): { @header contentType: "text/plain"; @body body: string };
}

@route("/binary")
interface Binary {
  @get download(): { @header contentType: "application/octet-stream"; @body body: bytes };
}
`;

const unsupportedContentTypeSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "UnsupportedApi" })
namespace UnsupportedApi;

@route("/feed")
interface Feed {
  @get list(): { @header contentType: "application/xml"; @body body: string };
}
`;

const multiSuccessContentTypeSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "FeedApi" })
namespace FeedApi;

model Pet { id: string; }

model JsonFeed {
  @statusCode _: 200;
  @header contentType: "application/json";
  @body body: Pet[];
}

model CsvFeed {
  @statusCode _: 200;
  @header contentType: "text/csv";
  @body body: string;
}

@route("/feed")
@get op list(): JsonFeed | CsvFeed;
`;

const envelopeObjectBodyDispatchSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "EnvelopeApi" })
namespace EnvelopeApi;

// Two envelopes sharing status + content type. Body shapes are both objects,
// so resolveEnvelopeBodyShapeBranches can't separate them on \`Array.isArray\`
// / typeof — dispatch must inspect properties INSIDE \`result.body\`.
model JsonAlpha {
  @statusCode _: 200;
  @header contentType: "application/json";
  @body body: { kind: "alpha"; alphaField: string };
}

model JsonBeta {
  @statusCode _: 200;
  @header contentType: "application/json";
  @body body: { kind: "beta"; betaField: string };
}

@route("/items")
@get op fetch(): JsonAlpha | JsonBeta;
`;

const multiErrorSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "MultiErrorApi" })
namespace MultiErrorApi;

model Item { id: string; name: string; }

@error model NotFoundError {
  @statusCode _: 404;
  code: "NOT_FOUND";
  message: string;
}

@error model ForbiddenError {
  @statusCode _: 403;
  code: "FORBIDDEN";
  message: string;
}

@error model ConflictError {
  @statusCode _: 409;
  conflictId: string;
  message: string;
}

@route("/items")
interface Items {
  // Single error
  @get read(@path itemId: string): Item | NotFoundError;
  // Two errors with shared discriminant field
  @delete remove(@path itemId: string): void | NotFoundError | ForbiddenError;
  // Error without a shared literal field — falls back to byProperty
  @put update(@path itemId: string, @body body: Item): Item | NotFoundError | ConflictError;
}
`;

const multiSuccessSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "MultiSuccessApi" })
namespace MultiSuccessApi;

model CreatedItem {
  @statusCode _: 201;
  id: string;
}

model AcceptedJob {
  @statusCode _: 202;
  operationId: string;
}

@route("/items")
interface Items {
  @post create(): CreatedItem | AcceptedJob;
}
`;

const discriminatorSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "DiscriminatorApi" })
namespace DiscriminatorApi;

@discriminator("kind")
model CreateResult {
  kind: string;
}

model CreatedItem extends CreateResult {
  @statusCode _: 201;
  kind: "created";
  id: string;
}

model AcceptedJob extends CreateResult {
  @statusCode _: 202;
  kind: "accepted";
  operationId: string;
}

@route("/items")
interface Items {
  @post create(): CreatedItem | AcceptedJob;
}
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("response encoding", () => {
  test("void response emits 204 with empty body", () => {
    const r = compileFixture("void", voidSpec);

    expect(r.readFile("void-api", "server-operations.ts")).toMatchSnapshot();
    expect(r.readFile("void-api", "server.ts")).toMatchSnapshot();
  });

  test("array response types", () => {
    const r = compileFixture("arrays", arraySpec);

    expect(r.readFile("array-api", "server.ts")).toMatchSnapshot();
    expect(r.readFile("array-api", "models.ts")).toMatchSnapshot();
  });

  test("enum and union types in models", () => {
    const r = compileFixture("enums", enumSpec);

    expect(r.readFile("enum-api", "models.ts")).toMatchSnapshot();
  });

  test("response @header properties become HTTP headers", () => {
    const r = compileFixture("response-headers", responseHeadersSpec);

    expect(r.readFile("headers-api", "server-operations.ts")).toMatchSnapshot();
    expect(r.readFile("headers-api", "models.ts")).toMatchSnapshot();
  });

  test("text and binary content types use correct encoders", () => {
    const r = compileFixture("content-types", contentTypeSpec);
    const operations = r.readFile("content-api", "server-operations.ts");

    expect(operations).toMatchSnapshot();
    // Text/binary responses must not be silently wrapped in JSON encoders.
    expect(operations).toContain(`kind: "text"`);
    expect(operations).toContain(`kind: "bytes"`);
    expect(operations).not.toContain("ResponseEncoders.json<string>");
    expect(operations).not.toContain("ResponseEncoders.json<Uint8Array>");
    expect(operations).not.toContain("ResponseEncoders.json<{ body: string }>");
    expect(operations).not.toContain("ResponseEncoders.json<{ body: Uint8Array }>");
  });

  test("unsupported response content type produces a diagnostic and a poisoned encoder", () => {
    const r = compileFixtureExpectingDiagnostics(
      "unsupported-response-ct",
      unsupportedContentTypeSpec,
    );

    const combined = `${r.diagnostics.stdout}\n${r.diagnostics.stderr}`;
    expect(combined).toContain("unsupported-response-content-type");
    expect(combined).toContain("application/xml");
    expect(combined).toContain("list");

    // TypeSpec writes generated files even on error-severity diagnostics.
    // The emitted encoder must throw at runtime, not silently fall back to JSON.
    const operations = r.readFile("unsupported-api", "server-operations.ts");
    expect(operations).toContain(`ResponseEncoders.unsupported<`);
    expect(operations).toContain("application/xml");
    expect(operations).not.toContain("ResponseEncoders.json<");
  });

  test("multiple error types generate matchVariant result encoders", () => {
    const r = compileFixture("multi-errors", multiErrorSpec);

    expect(r.readFile("multi-error-api", "server-operations.ts")).toMatchSnapshot();
    expect(r.readFile("multi-error-api", "models.ts")).toMatchSnapshot();
  });

  test("multiple success types generate matchVariant result encoders", () => {
    const r = compileFixture("multi-success", multiSuccessSpec);

    expect(r.readFile("multi-success-api", "server-operations.ts")).toMatchSnapshot();
    expect(r.readFile("multi-success-api", "server.ts")).toMatchSnapshot();
  });

  test("multiple success content types under one status emit per-variant encoders", () => {
    const r = compileFixture("multi-success-ct", multiSuccessContentTypeSpec);
    const operations = r.readFile("feed-api", "server-operations.ts");
    const server = r.readFile("feed-api", "server.ts");

    // Handler signature exposes BOTH variants. contentType is set by the
    // runtime per-variant, so it stays out of the handler-facing shape.
    expect(server).toContain(`{ body: Pet[] }`);
    expect(server).toContain(`{ body: string }`);

    // matchVariant dispatcher with one branch per declared content type.
    expect(operations).toContain("ResponseEncoders.matchVariant<");
    expect(operations).toContain(`contentType: "application/json"`);
    expect(operations).toContain(`contentType: "text/csv"`);

    // Each branch uses the encoder kind matching its declared CT.
    // CSV must NOT serialize through the JSON path.
    expect(operations).toContain(`kind: "text"`);
    expect(operations).not.toContain(`ResponseEncoders.json<{ body: string }>`);

    // No silent fallback / unsupported placeholder.
    expect(operations).not.toContain("ResponseEncoders.unsupported<");

    // Dispatch predicates discriminate on the body's runtime shape, not on
    // status alone (which would always pick the first variant).
    expect(operations).toMatch(/Array\.isArray\(.*?\["body"\]\)/);
    expect(operations).toMatch(/typeof .*?\["body"\] === "string"/);
  });

  test("envelope variants with object bodies dispatch on body fields, not envelope fields", () => {
    const r = compileFixture("envelope-object-dispatch", envelopeObjectBodyDispatchSpec);
    const operations = r.readFile("envelope-api", "server-operations.ts");

    // Handler signature shows both envelope shapes.
    expect(operations).toContain(`{ body: { kind: "alpha"; alphaField: string } }`);
    expect(operations).toContain(`{ body: { kind: "beta"; betaField: string } }`);

    // Dispatch must target the body's properties, not the envelope's. The
    // handler returns `{ body: {...} }` — checking `"kind" in result` would
    // always be false because `kind` lives one level down.
    expect(operations).toMatch(/\["body"\][^=]*===\s*"alpha"/);
    expect(operations).toMatch(/\["body"\][^=]*===\s*"beta"/);

    // Must NOT emit predicates that target the envelope (which has no `kind`
    // or `alphaField` property).
    expect(operations).not.toMatch(/"kind" in result\b/);
    expect(operations).not.toMatch(/"alphaField" in result\b/);
    expect(operations).not.toMatch(/"betaField" in result\b/);

    // No silent fallback to unsupported.
    expect(operations).not.toContain("ResponseEncoders.unsupported<");

    r.typecheck("envelope-api");
  });

  test("discriminator response unions generate readable type guards", () => {
    const r = compileFixture("discriminator", discriminatorSpec);

    expect(r.readFile("discriminator-api", "models.ts")).toMatchSnapshot();
    expect(r.readFile("discriminator-api", "server-operations.ts")).toMatchSnapshot();
  });
});
