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

const nestedInheritedSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "NestedGenericApi" })
namespace NestedGenericApi;

model Envelope<T> {
  data: T;
}

model Page<T> extends Envelope<T> {
  items: T[];
  byId: Record<T>;
  tuple: [T, string];
}

model Pair<L, R> {
  left: L;
  right: R;
}

model Pet {
  id: string;
}

model User {
  id: string;
}

@route("/nested")
interface Nested {
  @get read(): Page<Pair<Pet, User>>;
  @post create(@body body: Page<Pair<Pet, User>>): Page<Pair<Pet, User>>;
}
`;

const valueAndDefaultSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "ValueGenericApi" })
namespace ValueGenericApi;

model Pet {
  id: string;
}

model Resource<Name extends valueof string, T = string> {
  value: T;
}

@route("/resources")
interface Resources {
  @get read(): Resource<"pets", Pet>;
  @route("/default")
  @get readDefault(): Resource<"default">;
}
`;

const standardTemplateSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "StandardTemplateApi" })
namespace StandardTemplateApi;

model Owner {
  id: string;
}

model Pet {
  id: string;
  name: string;
  owner?: Owner;
}

@route("/pets")
interface Pets {
  @get readPartial(): OptionalProperties<Pet>;
  @post update(@body body: PickProperties<Pet, "id" | "owner">): OmitProperties<Pet, "name">;
}
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
    r.typecheck("generic-api");
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
    r.typecheck("multi-generic-api");
  });

  test("emits inherited nested generic models with collection properties", () => {
    const r = compileFixture("generic-nested-inherited", nestedInheritedSpec);
    const models = r.readFile("nested-generic-api", "models.ts");
    const server = r.readFile("nested-generic-api", "server.ts");
    const operations = r.readFile("nested-generic-api", "server-operations.ts");

    expect(models).toContain("export interface Envelope<T>");
    expect(models).toContain("export interface Page<T> extends Envelope<T>");
    expect(models).toContain("byId: Record<string, T>;");
    expect(models).toContain("tuple: [T, string];");
    expect(models).toContain("export interface Pair<L, R>");
    expect(server).toContain(
      "OperationHandler<Record<string, never>, Page<Pair<Pet, User>>, Ctx>",
    );
    expect(server).toContain(
      "OperationHandler<Page<Pair<Pet, User>>, Page<Pair<Pet, User>>, Ctx>",
    );
    expect(operations).toContain("Decoders.record(");
    expect(operations).toContain("Decoders.tuple<[Pair<Pet, User>, string]>");
    r.typecheck("nested-generic-api");
  });

  test("preserves value template arguments and defaulted type arguments", () => {
    const r = compileFixture("generic-values", valueAndDefaultSpec);
    const models = r.readFile("value-generic-api", "models.ts");
    const server = r.readFile("value-generic-api", "server.ts");

    expect(models).toContain("export interface Resource<Name extends string, T = string>");
    expect(server).toContain(
      "OperationHandler<Record<string, never>, Resource<\"pets\", Pet>, Ctx>",
    );
    expect(server).toContain(
      "OperationHandler<Record<string, never>, Resource<\"default\", string>, Ctx>",
    );
    r.typecheck("value-generic-api");
  });

  test("inlines standard TypeSpec generic model transforms instead of importing missing models", () => {
    const r = compileFixture("generic-standard-templates", standardTemplateSpec);
    const server = r.readFile("standard-template-api", "server.ts");
    const operations = r.readFile("standard-template-api", "server-operations.ts");

    expect(server).not.toContain("OptionalProperties");
    expect(server).not.toContain("PickProperties");
    expect(server).not.toContain("OmitProperties");
    expect(server).toContain("readonly readPartial: OperationHandler<");
    expect(server).toContain("Record<string, never>,");
    expect(server).toContain("{ id?: string; name?: string; owner?: Owner },");
    expect(server).toContain("readonly update: OperationHandler<");
    expect(server).toContain("{ id: string; owner?: Owner },");
    expect(operations).not.toContain("OptionalProperties");
    expect(operations).not.toContain("PickProperties");
    expect(operations).not.toContain("OmitProperties");
    expect(operations).toContain("owner: Decoders.optional(Decoders.object<Owner>({ id: Decoders.string }))");
    r.typecheck("standard-template-api");
  });
});
