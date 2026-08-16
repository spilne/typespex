import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildEmitter,
  cleanupFixtures,
  compileFixture,
  compileFixtureExpectingDiagnostics,
} from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const objectEnvelopeSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "DiscriminatedEnvelopeApi" })
namespace DiscriminatedEnvelopeApi;

model Cat {
  @encodedName("application/json", "display_name")
  displayName: string;
  meows: boolean;
}

model Dog {
  @encodedName("application/json", "display_name")
  displayName: string;
  barks: boolean;
}

model UnknownPet {
  raw: string;
}

@discriminated(#{
  discriminatorPropertyName: "petType",
  envelopePropertyName: "payload",
})
union Pet {
  cat: Cat,
  dog: Dog,
  UnknownPet,
}

@route("/pets")
@post
op roundTrip(@body body: Pet): Pet;
`;

const inlineEnvelopeSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "InlineDiscriminatorApi" })
namespace InlineDiscriminatorApi;

model Cat {
  @visibility(Lifecycle.Read) id: string;
  @visibility(Lifecycle.Update) updateName: string;
  @encodedName("application/json", "display_name")
  displayName: string;
}

model Dog {
  species: "dog";
  @visibility(Lifecycle.Read) id: string;
  @visibility(Lifecycle.Update) updateName: string;
  @encodedName("application/json", "display_name")
  displayName: string;
}

@discriminated(#{ envelope: "none", discriminatorPropertyName: "species" })
union Pet {
  cat: Cat,
  dog: Dog,
}

@route("/pets/{petId}")
@patch(#{ implicitOptionality: true })
op update(@path petId: string, @body body: Pet): Pet;
`;

const recursiveEnvelopeSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "RecursiveDiscriminatorApi" })
namespace RecursiveDiscriminatorApi;

@discriminated
union Tree {
  leaf: Leaf,
  branch: Branch,
}

model Leaf { text: string; }
model Branch { children: Tree[]; }

@discriminated
union SpecialValue {
  __proto__: PrototypeValue,
  constructor: ConstructorValue,
}
model PrototypeValue { text: string; }
model ConstructorValue { count: int32; }

@route("/tree")
@post
op tree(@body body: Tree): Tree;

@route("/special")
@post
op special(@body body: SpecialValue): SpecialValue;
`;

const genericEnvelopeSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "GenericDiscriminatorApi" })
namespace GenericDiscriminatorApi;

model Failure { message: string; }

@discriminated(#{ discriminatorPropertyName: "resultKind" })
union Result<T> {
  ok: T,
  error: Failure,
}

model Payload { result: Result<string>; }

@route("/result")
@post
op roundTrip(@body body: Payload): Payload;
`;

function jsonRequest(method: string, path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("TypeSpec @discriminated unions", () => {
  test("emits, decodes, and serializes custom object envelopes and default variants", async () => {
    const result = compileFixture("discriminated-object-envelope", objectEnvelopeSpec);
    const models = result.readFile("discriminated-envelope-api", "models.ts");
    const operations = result.readFile("discriminated-envelope-api", "server-operations.ts");

    expect(models).toContain('export type Pet =\n  | { petType: "cat"; payload: Cat }');
    expect(models).toContain('| { petType: "dog"; payload: Dog }');
    expect(models).toContain("| { petType: string; payload: UnknownPet };");
    expect(operations).toMatch(/Decoders\.discriminated<Pet>\(\s*"petType"/);
    expect(operations).toContain("defaultVariant:");
    expect(operations).toMatch(/JsonSerializers\.discriminated<Pet>\(\s*"petType"/);
    result.typecheck("discriminated-envelope-api");

    const { createDiscriminatedEnvelopeApiServerRouter } = await import(
      `${result.outputDir}/discriminated-envelope-api/server-router.ts`
    );
    let received: unknown;
    const router = createDiscriminatedEnvelopeApiServerRouter({
      roundTrip(input: unknown) {
        received = input;
        return input;
      },
    } as any);

    const catWire = {
      petType: "cat",
      payload: { display_name: "Miso", meows: true },
    };
    const cat = await router.handle(jsonRequest("POST", "/pets", catWire));
    expect(cat.status).toBe(200);
    expect(received).toEqual({
      petType: "cat",
      payload: { displayName: "Miso", meows: true },
    });
    expect(await cat.json()).toEqual(catWire);

    const futureWire = { petType: "future", payload: { raw: "opaque" } };
    const future = await router.handle(jsonRequest("POST", "/pets", futureWire));
    expect(future.status).toBe(200);
    expect(received).toEqual(futureWire);
    expect(await future.json()).toEqual(futureWire);

    const malformed = await router.handle(
      jsonRequest("POST", "/pets", { petType: "cat", payload: { meows: true } }),
    );
    expect(malformed.status).toBe(400);
  });

  test("injects inline discriminators through request and response visibility projections", async () => {
    const result = compileFixture("discriminated-inline-envelope", inlineEnvelopeSpec);
    const models = result.readFile("inline-discriminator-api", "models.ts");
    const server = result.readFile("inline-discriminator-api", "server.ts");
    const operations = result.readFile("inline-discriminator-api", "server-operations.ts");

    expect(models).toContain(
      'export type Pet = ({ species: "cat" } & Cat) | ({ species: "dog" } & Dog);',
    );
    expect(server).toMatch(/species: "cat"/);
    expect(operations).toContain('species: Decoders.strictLiteral("cat")');
    expect(operations).toContain("JsonSerializers.discriminated<");
    result.typecheck("inline-discriminator-api");

    const { createInlineDiscriminatorApiServerRouter } = await import(
      `${result.outputDir}/inline-discriminator-api/server-router.ts`
    );
    let received: unknown;
    const router = createInlineDiscriminatorApiServerRouter({
      update(input: unknown) {
        received = input;
        const body = (input as { body: { species: string } }).body;
        if (body.species === "dog") {
          return {
            species: "dog",
            id: "dog-1",
            updateName: "must-not-leak",
            displayName: "Updated dog",
          };
        }
        return {
          species: "cat",
          id: "cat-1",
          updateName: "must-not-leak",
          displayName: "Updated cat",
        };
      },
    } as any);

    const response = await router.handle(
      jsonRequest("PATCH", "/pets/cat-1", {
        species: "cat",
        updateName: "new-name",
        display_name: "Request cat",
      }),
    );
    expect(response.status).toBe(200);
    expect(received).toEqual({
      petId: "cat-1",
      body: {
        species: "cat",
        updateName: "new-name",
        displayName: "Request cat",
      },
    });
    expect(await response.json()).toEqual({
      species: "cat",
      id: "cat-1",
      display_name: "Updated cat",
    });

    const dogResponse = await router.handle(
      jsonRequest("PATCH", "/pets/dog-1", {
        species: "dog",
        updateName: "new-dog-name",
        display_name: "Request dog",
      }),
    );
    expect(dogResponse.status).toBe(200);
    expect(await dogResponse.json()).toEqual({
      species: "dog",
      id: "dog-1",
      display_name: "Updated dog",
    });

    const missingDiscriminator = await router.handle(
      jsonRequest("PATCH", "/pets/cat-1", { updateName: "new-name" }),
    );
    expect(missingDiscriminator.status).toBe(400);

    const unknownDiscriminator = await router.handle(
      jsonRequest("PATCH", "/pets/cat-1", { species: "bird" }),
    );
    expect(unknownDiscriminator.status).toBe(400);
  });

  test("supports recursive envelopes and prototype-sensitive variant names", async () => {
    const result = compileFixture("discriminated-recursive", recursiveEnvelopeSpec);
    const models = result.readFile("recursive-discriminator-api", "models.ts");
    const operations = result.readFile("recursive-discriminator-api", "server-operations.ts");

    expect(models).toContain(
      'export type Tree = { kind: "leaf"; value: Leaf } | { kind: "branch"; value: Branch };',
    );
    expect(operations).toMatch(/JsonSerializers\.lazy<Tree>/);
    expect(operations).toContain('["__proto__"]: Decoders.object<');
    expect(operations).toContain('["__proto__"]: JsonSerializers.object<');
    result.typecheck("recursive-discriminator-api");

    const { createRecursiveDiscriminatorApiServerRouter } = await import(
      `${result.outputDir}/recursive-discriminator-api/server-router.ts`
    );
    const router = createRecursiveDiscriminatorApiServerRouter({
      tree: (input: unknown) => input,
      special: (input: unknown) => input,
    } as any);
    const treeWire = {
      kind: "branch",
      value: { children: [{ kind: "leaf", value: { text: "first" } }] },
    };
    const tree = await router.handle(jsonRequest("POST", "/tree", treeWire));
    expect(tree.status).toBe(200);
    expect(await tree.json()).toEqual(treeWire);

    const specialWire = { kind: "__proto__", value: { text: "safe" } };
    const special = await router.handle(jsonRequest("POST", "/special", specialWire));
    expect(special.status).toBe(200);
    expect(await special.json()).toEqual(specialWire);

    const malformedTree = await router.handle(
      jsonRequest("POST", "/tree", { kind: "branch", value: {} }),
    );
    expect(malformedTree.status).toBe(400);
  });

  test("preserves discriminated metadata on generic union declarations and instances", async () => {
    const result = compileFixture("discriminated-generic", genericEnvelopeSpec);
    const models = result.readFile("generic-discriminator-api", "models.ts");
    const operations = result.readFile("generic-discriminator-api", "server-operations.ts");

    expect(models).toContain(
      'export type Result<T> = { resultKind: "ok"; value: T } | { resultKind: "error"; value: Failure };',
    );
    expect(operations).toMatch(/Decoders\.discriminated<Result<string>>\(\s*"resultKind"/);
    expect(operations).toMatch(/JsonSerializers\.discriminated<Result<string>>\(\s*"resultKind"/);
    result.typecheck("generic-discriminator-api");

    const { createGenericDiscriminatorApiServerRouter } = await import(
      `${result.outputDir}/generic-discriminator-api/server-router.ts`
    );
    const router = createGenericDiscriminatorApiServerRouter({
      roundTrip: (input: unknown) => input,
    } as any);
    const wire = { result: { resultKind: "ok", value: "complete" } };
    const response = await router.handle(jsonRequest("POST", "/result", wire));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(wire);
  });

  test("rejects inline default variants that cannot receive a property", () => {
    const result = compileFixtureExpectingDiagnostics(
      "discriminated-inline-scalar-default",
      `
      import "@typespec/http";
      using TypeSpec.Http;

      @service namespace InvalidInlineDiscriminatorApi {
        model Cat { name: string; }
        @discriminated(#{ envelope: "none" })
        union Pet { cat: Cat, string }
        @route("/pets") @post op create(@body body: Pet): Pet;
      }
    `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("unsupported-discriminated-union");
    expect(diagnostics).toContain("default variant must be an object model");
    expect(result.listFiles("invalid-inline-discriminator-api")).toEqual([]);
  });

  test("rejects object envelopes whose synthetic property names collide", () => {
    const result = compileFixtureExpectingDiagnostics(
      "discriminated-envelope-collision",
      `
      import "@typespec/http";
      using TypeSpec.Http;

      @service namespace InvalidDiscriminatorEnvelopeApi {
        @discriminated(#{
          discriminatorPropertyName: "data",
          envelopePropertyName: "data",
        })
        union Value { text: string }
        @route("/value") @post op create(@body body: Value): Value;
      }
    `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("unsupported-discriminated-union");
    expect(diagnostics).toContain('both use "data"');
    expect(result.listFiles("invalid-discriminator-envelope-api")).toEqual([]);
  });
});
