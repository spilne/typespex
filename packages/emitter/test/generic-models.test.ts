import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildEmitter, cleanupFixtures, compileFixture } from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const genericResponseSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "GenericApi" })
namespace GenericApi;

model Page<T> {
  items: T[];
}

model Pet {
  id: string;
}

@route("/pets")
interface Pets {
  @get list(): Page<Pet>;
  @post create(@body body: Page<Pet>): Page<Pet>;
}
`;

const multiInstantiationSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "MultiGenericApi" })
namespace MultiGenericApi;

model Page<T> {
  items: T[];
}

model Pet {
  id: string;
}

model User {
  id: string;
}

model Accepted {
  @statusCode _: 202;
  operationId: string;
}

@route("/pets")
@get op listPets(): Page<Pet> | Accepted;

@route("/users")
@get op listUsers(): Page<User>;
`;

describe("generic models", () => {
  test("emits generic model declarations and instantiated operation types", () => {
    const r = compileFixture("generic-response", genericResponseSpec);
    const serverOperations = r.readFile("generic-api", "server-operations.ts");

    expect(r.readFile("generic-api", "models.ts")).toContain("export interface Page<T>");
    expect(r.readFile("generic-api", "models.ts")).toContain("items: T[];");
    expect(r.readFile("generic-api", "server.ts")).toContain(
      "OperationHandler<Record<string, never>, Page<Pet>, Ctx>",
    );
    expect(r.readFile("generic-api", "server.ts")).toContain(
      "OperationHandler<Page<Pet>, Page<Pet>, Ctx>",
    );
    expect(serverOperations).toContain("ResponseEncoders.json<Page<Pet>>(200)");
    expect(serverOperations).toContain("Decoders.object<Page<Pet>>");
    expect(serverOperations).toContain(
      "items: Decoders.strictArray(Decoders.object<Pet>({ id: Decoders.string }))",
    );
  });

  test("reuses one generic declaration for multiple concrete instantiations", () => {
    const r = compileFixture("generic-multi", multiInstantiationSpec);

    expect(r.readFile("multi-generic-api", "models.ts")).toContain("export interface Page<T>");
    expect(r.readFile("multi-generic-api", "server-operations.ts")).toContain("Page<Pet> | Accepted");
    expect(r.readFile("multi-generic-api", "server-operations.ts")).toContain("Page<User>");
    expect(r.readFile("multi-generic-api", "server.ts")).toContain(
      "OperationHandler<Record<string, never>, Page<Pet> | Accepted, Ctx>",
    );
    expect(r.readFile("multi-generic-api", "server.ts")).toContain(
      "OperationHandler<Record<string, never>, Page<User>, Ctx>",
    );
  });
});
