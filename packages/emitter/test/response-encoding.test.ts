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
});
