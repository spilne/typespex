import { afterAll, beforeAll, expect, test } from "bun:test";
import { buildEmitter, cleanupFixtures, compileFixture } from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const petstoreSpec = `
import "@typespec/http";
import "./lib.js";

using TypeSpec.Http;
using TypeSpec.Reflection;

extern dec auth(target: Operation, scope: valueof string);

@service(#{ title: "PetStore" })
namespace PetStore {
  model Pet {
    @minLength(1) id: string;
    @minLength(1) @maxLength(80) name: string;
    @maxLength(40) tag?: string;
  }

  model CreatePetInput {
    @minLength(1) @maxLength(80)
    @pattern("^[A-Za-z].*", "Must start with a letter.")
    name: string;
    @maxLength(40) tag?: string;
  }

  @error model NotFoundError {
    @statusCode _: 404;
    code: "NOT_FOUND";
    message: string;
  }

  @route("/pets")
  interface Pets {
    @get list(
      @minValue(1) @maxValue(100) @query limit?: int32,
      @minValue(0) @query offset?: int32,
    ): Pet[];

    @post create(@body body: CreatePetInput): Pet;

    @get read(@minLength(1) @path petId: string): Pet | NotFoundError;

    @auth("admin")
    @delete delete(@minLength(1) @path petId: string): void | NotFoundError;
  }
}
`;

test("petstore — full integration", () => {
  const r = compileFixture("petstore", petstoreSpec, "", {
    "lib.js": "export function $auth() {}",
  });

  expect(r.fileExists("pet-store", "server.ts")).toBe(true);
  expect(r.fileExists("pet-store", "server-hints.ts")).toBe(true);
  expect(r.fileExists("pet-store", "server-operations.ts")).toBe(true);
  expect(r.fileExists("pet-store", "server-router.ts")).toBe(true);
  expect(r.fileExists("pet-store", "models.ts")).toBe(true);

  expect(r.readFile("pet-store", "models.ts")).toMatchSnapshot();
  expect(r.readFile("pet-store", "server.ts")).toMatchSnapshot();
  expect(r.readFile("pet-store", "server-hints.ts")).toMatchSnapshot();
  expect(r.readFile("pet-store", "server-operations.ts")).toMatchSnapshot();
  expect(r.readFile("pet-store", "server-router.ts")).toMatchSnapshot();
});
