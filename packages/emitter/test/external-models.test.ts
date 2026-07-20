import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildEmitter, cleanupFixtures, compileFixture } from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const externalModelsSpec = `
import "@typespec/http";
using TypeSpec.Http;

namespace Common {
  model Metadata {
    version: string;
  }

  enum Kind {
    primary: "primary",
    secondary: "secondary",
  }

  model Thing {
    id: string;
    kind: Kind;
  }

  model Envelope<T> {
    value: T;
    metadata: Metadata;
  }
}

@service(#{ title: "ExternalApi" })
namespace ExternalApi {
  model Local {
    common: Common.Thing;
  }

  @route("/thing")
  @get op read(): Common.Envelope<Local>;
}
`;

const collidingExternalModelsSpec = `
import "@typespec/http";
using TypeSpec.Http;

namespace First {
  model Item { source: "first"; }
}

namespace Second {
  model Item { source: "second"; }
}

@service(#{ title: "CollisionApi" })
namespace CollisionApi {
  model Pair {
    first: First.Item;
    second: Second.Item;
  }

  @route("/pair")
  @get op read(): Pair;
}
`;

const httpModelsSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "HttpModelsApi" })
namespace HttpModelsApi;

model Archive extends File<"application/octet-stream"> {}

model Detail {
  value: string;
}

model Payload {
  part: HttpPart<Detail>;
  archive: Archive;
}

@route("/payload")
@get op read(): Payload;
`;

const httpSourceReferencesSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "HttpSourceReferencesApi" })
namespace HttpSourceReferencesApi;

model Box<T> {
  value: T;
}

model PartBox extends Box<HttpPart<string>> {}
model FileBox extends Box<File<"application/octet-stream">> {}
model IntBox extends Box<TypeSpec.int32> {}

union BoxedValue {
  part: Box<HttpPart<int32>>,
  file: Box<File<"text/plain">>,
  enabled: Box<TypeSpec.boolean>,
}

model Payload {
  part: PartBox;
  file: FileBox;
  count: IntBox;
  value: BoxedValue;
}

@route("/payload")
@get op read(): Payload;
`;

describe("external model dependencies", () => {
  test("emits the dependency closure for external and generic models", () => {
    const r = compileFixture("external-models", externalModelsSpec);
    const models = r.readFile("external-api", "models.ts");
    const server = r.readFile("external-api", "server.ts");

    expect(models).toContain("export interface Thing");
    expect(models).toContain("export interface Metadata");
    expect(models).toContain("export interface Envelope<T>");
    expect(models).toContain("common: Thing;");
    expect(models).toContain("metadata: Metadata;");
    expect(server).toContain("OperationHandler<Record<string, never>, Envelope<Local>, Ctx>");
    r.typecheck("external-api");
  });

  test("qualifies colliding external model names", () => {
    const r = compileFixture("external-model-collisions", collidingExternalModelsSpec);
    const models = r.readFile("collision-api", "models.ts");

    expect(models).toContain("export interface First_Item");
    expect(models).toContain("export interface Second_Item");
    expect(models).toContain("first: First_Item;");
    expect(models).toContain("second: Second_Item;");
    r.typecheck("collision-api");
  });

  test("excludes canonical HTTP wrapper and file models from generated imports", () => {
    const r = compileFixture("http-model-imports", httpModelsSpec);
    const models = r.readFile("http-models-api", "models.ts");
    const operations = r.readFile("http-models-api", "server-operations.ts");

    expect(models).toContain("export interface Payload");
    expect(models).not.toContain("export interface Archive");
    expect(models).not.toContain("export interface HttpPart");
    expect(models).toContain("export interface Detail");
    expect(models).toContain("part: Detail;");
    expect(models).toContain("archive: File;");
    expect(operations).toContain('import type { Detail, Payload } from "./models.js";');
    expect(operations).not.toContain("Archive");
    expect(operations).not.toContain("HttpPart");
    r.typecheck("http-models-api");
  });

  test("uses semantic HTTP leaf types in source-form references", () => {
    const r = compileFixture("http-source-references", httpSourceReferencesSpec);
    const models = r.readFile("http-source-references-api", "models.ts");

    expect(models).toContain("export interface PartBox extends Box<string>");
    expect(models).toContain("export interface FileBox extends Box<File>");
    expect(models).toContain("export interface IntBox extends Box<number>");
    expect(models).toContain("export type BoxedValue = Box<number> | Box<File> | Box<boolean>;");
    expect(models).not.toContain("TypeSpec.");
    expect(models).not.toContain("HttpPart<");
    expect(models).not.toContain('File<"');
    r.typecheck("http-source-references-api");
  });
});
