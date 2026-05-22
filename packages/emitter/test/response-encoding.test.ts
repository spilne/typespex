import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildEmitter, cleanupFixtures, compileFixture } from "./compile-fixture.js";

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

    expect(r.readFile("content-api", "server-operations.ts")).toMatchSnapshot();
  });

  test("multiple error types generate direct result encoders", () => {
    const r = compileFixture("multi-errors", multiErrorSpec);

    expect(r.readFile("multi-error-api", "server-operations.ts")).toMatchSnapshot();
    expect(r.readFile("multi-error-api", "models.ts")).toMatchSnapshot();
  });

  test("multiple success types generate direct result encoders", () => {
    const r = compileFixture("multi-success", multiSuccessSpec);

    expect(r.readFile("multi-success-api", "server-operations.ts")).toMatchSnapshot();
    expect(r.readFile("multi-success-api", "server.ts")).toMatchSnapshot();
  });
});
