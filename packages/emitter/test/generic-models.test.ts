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
  @route("/{pageId}")
  @put update(@path pageId: string, @body body: Page<Pair<Pet, User>>): Page<Pair<Pet, User>>;
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

const templatedOperationSurfaceSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "TemplateSurfaceApi" })
namespace TemplateSurfaceApi;

model Page<T> {
  items: T[];
}

model Pet {
  id: string;
}

interface ReadOps<T> {
  @get read(): Page<T>;
}

op readTemplate<T>(): Page<T>;

@route("/pets")
interface Pets extends ReadOps<Pet> {
  @route("/template")
  @get readFromTemplate is readTemplate<Pet>;
}
`;

const templatedUnionAndScalarSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "TemplateTypeApi" })
namespace TemplateTypeApi;

model Pet {
  id: string;
}

union Maybe<T> {
  value: T,
  none: null,
}

scalar Tagged<Name extends valueof string> extends string;

model TaggedPet {
  id: Tagged<"pet">;
  maybe: Maybe<Pet>;
}

namespace Shared {
  model Box<T> {
    boxed: T;
  }
}

model QualifiedPetBox extends Shared.Box<Pet> {}

model Accepted<T> {
  @statusCode _: 202;
  value: T;
}

union Result<T> {
  ok: T,
  accepted: Accepted<T>,
}

union Qualified<T> {
  boxed: Shared.Box<T>,
  accepted: Accepted<T>,
}

@route("/types")
interface Types {
  @route("/maybe")
  @get readMaybe(): Maybe<Pet>;

  @route("/result")
  @get readResult(): Result<Pet>;

  @route("/qualified")
  @get readQualified(): Qualified<Pet>;

  @route("/maybe")
  @post createMaybe(@body body: Maybe<Pet>): TaggedPet;

  @route("/tagged")
  @post createTagged(@body body: TaggedPet): Tagged<"pet">;

  @route("/tag")
  @post echoTagged(@body body: Tagged<"pet">): Tagged<"pet">;

  @route("/scoped/{ownerId}")
  @post createScoped(@path ownerId: string, @body body: Maybe<Pet>): TaggedPet;

  @route("/search")
  @get search(@query tag: Tagged<"pet">): TaggedPet;
}
`;

const arrayUnionElementSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "ArrayUnionApi" })
namespace ArrayUnionApi;

model Pet {
  kind: "pet";
  petId: string;
}

model User {
  kind: "user";
  userId: string;
}

model Collection {
  items: Array<Pet | User>;
}

@route("/collections")
interface Collections {
  @get read(): Collection;
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
    expect(operations).toContain("data: Decoders.object<Pair<Pet, User>>");
    expect(operations).toContain("Decoders.record(");
    expect(operations).toContain("Decoders.tuple<[Pair<Pet, User>, string]>");
    r.typecheck("nested-generic-api", {
      "handler-contract.ts": `
import type { NestedGenericApiServer } from "./server.js";
import type { Page, Pair, Pet, User } from "./models.js";

const pair: Pair<Pet, User> = {
  left: { id: "pet" },
  right: { id: "user" },
};

const page: Page<Pair<Pet, User>> = {
  data: pair,
  items: [pair],
  byId: { pair },
  tuple: [pair, "cursor"],
};

export const handlers: NestedGenericApiServer = {
  Nested: {
    read: () => page,
    create: (input) => input,
    update: (input) => {
      const pageId: string = input.pageId;
      const data: Pair<Pet, User> = input.data;
      return {
        data,
        items: input.items,
        byId: { [pageId]: data, ...input.byId },
        tuple: input.tuple,
      };
    },
  },
};
`,
    });
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

  test("preserves generic model references through templated interfaces and operations", () => {
    const r = compileFixture("generic-template-surfaces", templatedOperationSurfaceSpec);
    const server = r.readFile("template-surface-api", "server.ts");
    const operations = r.readFile("template-surface-api", "server-operations.ts");

    expect(server).toContain(
      "readonly read: OperationHandler<Record<string, never>, Page<Pet>, Ctx>",
    );
    expect(server).toContain(
      "readonly readFromTemplate: OperationHandler<Record<string, never>, Page<Pet>, Ctx>",
    );
    expect(operations).toContain("read: ResponseEncoders.json<Page<Pet>>(200)");
    expect(operations).toContain("readFromTemplate: ResponseEncoders.json<Page<Pet>>(200)");
    r.typecheck("template-surface-api");
  });

  test("emits templated union and scalar aliases used by operations and models", () => {
    const r = compileFixture("generic-union-scalar", templatedUnionAndScalarSpec);
    const models = r.readFile("template-type-api", "models.ts");
    const server = r.readFile("template-type-api", "server.ts");
    const operations = r.readFile("template-type-api", "server-operations.ts");

    expect(models).toContain("export type Tagged<Name extends string> = string;");
    expect(models).toContain("export type Maybe<T> = T | null;");
    expect(models).toContain("export interface Accepted<T>");
    expect(models).toContain("export interface Box<T>");
    expect(models).toContain("export interface QualifiedPetBox extends Box<Pet>");
    expect(models).toContain("export type Qualified<T> = Box<T> | Accepted<T>;");
    expect(models).not.toContain("Shared.Box");
    expect(models).toContain("id: Tagged<\"pet\">;");
    expect(models).toContain("maybe: Maybe<Pet>;");
    expect(server).toContain(
      "readonly readMaybe: OperationHandler<Record<string, never>, Maybe<Pet>, Ctx>",
    );
    expect(server).toContain(
      "readonly readResult: OperationHandler<Record<string, never>, Pet | Accepted<Pet>, Ctx>",
    );
    expect(server).toContain(
      "readonly readQualified: OperationHandler<Record<string, never>, Box<Pet> | Accepted<Pet>, Ctx>",
    );
    expect(server).toContain(
      "readonly createMaybe: OperationHandler<Maybe<Pet>, TaggedPet, Ctx>",
    );
    expect(server).toContain(
      "readonly createTagged: OperationHandler<TaggedPet, Tagged<\"pet\">, Ctx>",
    );
    expect(server).toContain(
      "readonly echoTagged: OperationHandler<Tagged<\"pet\">, Tagged<\"pet\">, Ctx>",
    );
    expect(server).toContain(
      "readonly createScoped: OperationHandler<{ ownerId: string; body: Maybe<Pet> }, TaggedPet, Ctx>",
    );
    expect(server).toContain(
      "readonly search: OperationHandler<{ tag: Tagged<\"pet\"> }, TaggedPet, Ctx>",
    );
    expect(operations).toContain("ResponseEncoders.json<Maybe<Pet>>(200)");
    expect(operations).toContain("ResponseEncoders.matchVariant<Pet | Accepted<Pet>>");
    expect(operations).toContain("ResponseEncoders.matchVariant<Box<Pet> | Accepted<Pet>>");
    expect(operations).toContain("createTagged: ResponseEncoders.text(200)");
    expect(operations).toContain("echoTagged: ResponseEncoders.text(200)");
    expect(operations).toContain("Decoders.union<Maybe<Pet>>");
    expect(operations).toContain("decodeBody<Maybe<Pet>>(request, TypesInput.createMaybe, {");
    expect(operations).toContain("decodeBody<Tagged<\"pet\">>(request, TypesInput.echoTagged, {");
    expect(operations).toContain("Decoders.object<TaggedPet>({");
    expect(operations).toContain("maybe: Decoders.union<Maybe<Pet>>");
    expect(operations).toContain(".map((body) => ({ body }))");
    expect(operations).toContain("decodeRequestInputAndBody<{ ownerId: string }, { body: Maybe<Pet> }>");
    expect(operations).toContain("RequestDecoders.query(\"tag\", Decoders.string)");
    r.typecheck("template-type-api");
  });

  test("preserves union element semantics for nominal Array instantiations", () => {
    const r = compileFixture("generic-array-union-element", arrayUnionElementSpec);

    r.typecheck("array-union-api", {
      "consumer-contract.ts": `
import type { Collection, Pet, User } from "./models.js";

const pet: Pet = { kind: "pet", petId: "pet" };
const user: User = { kind: "user", userId: "user" };

const collection: Collection = {
  items: [pet, user],
};

const first: Pet | User | undefined = collection.items[0];
void first;
`,
    });
  });
});
