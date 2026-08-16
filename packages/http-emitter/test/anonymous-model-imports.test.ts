import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildEmitter, cleanupFixtures, compileFixture } from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const anonymousRequestSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "AnonymousRequestApi" })
namespace AnonymousRequestApi;

model Pet { name: string; }
model Owner { name: string; }
model Tag { value: string; }

@route("/pets")
@post
op create(@body body: {
  pet: Pet;
  pets: Pet[];
  pair: [Pet, Owner];
  tags: Record<Tag>;
  subject: Pet | Owner;
  nested: { owner: Owner; tag: Tag };
}): void;
`;

const anonymousResponseSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "AnonymousResponseApi" })
namespace AnonymousResponseApi;

model Item { id: string; }
model ErrorDetail { message: string; }

@route("/items")
@get
op list(): {
  items: Item[];
  page: [Item, { fallback: ErrorDetail | Item }];
  failures: Record<ErrorDetail>;
};
`;

describe("anonymous operation model imports", () => {
  test("imports named types nested through request arrays, tuples, records, unions, and models", () => {
    const result = compileFixture("anonymous-request-imports", anonymousRequestSpec);
    const server = result.readFile("anonymous-request-api", "server.ts");
    const operations = result.readFile("anonymous-request-api", "server-operations.ts");

    for (const generated of [server, operations]) {
      expect(generated).toContain('import type { Owner, Pet, Tag } from "./models.js";');
    }
    result.typecheck("anonymous-request-api");
  });

  test("imports named types nested through a response-only anonymous model", () => {
    const result = compileFixture("anonymous-response-imports", anonymousResponseSpec);
    const server = result.readFile("anonymous-response-api", "server.ts");
    const operations = result.readFile("anonymous-response-api", "server-operations.ts");

    for (const generated of [server, operations]) {
      expect(generated).toContain('import type { ErrorDetail, Item } from "./models.js";');
    }
    result.typecheck("anonymous-response-api");
  });
});
