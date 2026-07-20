import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildEmitter, cleanupFixtures, compileFixture } from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const collisionSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "CollisionApi" })
namespace CollisionApi {
  namespace Sales {
    enum Category { Sales: "sales" }

    union Choice<T> {
      value: T,
      none: null,
    }

    union State {
      open: "open",
      closed: "closed",
    }

    scalar Label<Name extends valueof string> extends string;
    scalar Token extends string;

    model Item {
      area: "sales";
      category: Category;
      choice: Choice<string>;
      state: State;
      label: Label<"sales">;
      token: Token;
    }

    @route("/sales/items")
    interface Items {
      @get read(): Item;
    }

    @route("/sales/status")
    @get op status(): Item;
  }

  namespace Support {
    enum Category { Support: "support" }

    union Choice<T> {
      value: T,
      none: null,
    }

    union State {
      open: "open",
      closed: "closed",
    }

    scalar Label<Name extends valueof string> extends string;
    scalar Token extends string;

    model Item {
      area: "support";
      category: Category;
      choice: Choice<string>;
      state: State;
      label: Label<"support">;
      token: Token;
    }

    @route("/support/items")
    interface Items {
      @get read(): Item;
    }

    @route("/support/status")
    @get op status(): Item;
  }

  model Pair {
    sales: Sales.Item;
    support: Support.Item;
    salesChoice: Sales.Choice<Sales.Item>;
    supportChoice: Support.Choice<Support.Item>;
    salesLabel: Sales.Label<"sales">;
    supportLabel: Support.Label<"support">;
  }

  @route("/pair")
  @get op pair(): Pair;
}
`;

const groupCollisionSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "GroupApi" })
namespace GroupApi;

@route("/interface")
interface GroupApi {
  @get read(): string;
}

@route("/standalone")
@get op standalone(): string;
`;

const builtinLeafNameSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "BuiltinLeafNameApi" })
namespace BuiltinLeafNameApi {
  model Array<T> {
    value: T;
  }

  model Record<T> {
    value: T;
  }

  model File {
    value: string;
  }

  model HttpPart<T> {
    value: T;
  }

  model Payload {
    array: Array<string>;
    record: Record<string>;
    file: File;
    part: HttpPart<string>;
  }

  @route("/payload")
  @post op create(@body body: Payload): Payload;

  @route("/array")
  @get op readArray(): Array<string>;

  @route("/record")
  @get op readRecord(): Record<string>;

  @route("/file")
  @get op readFile(): File;

  @route("/part")
  @get op readPart(): HttpPart<string>;
}
`;

const globalServiceNameFallbackSpec = `
import "@typespec/http";

model File {
  value: string;
}

model Model_File {
  value: string;
}

model Payload {
  first: File;
  second: Model_File;
}

@TypeSpec.Http.route("/payload")
@TypeSpec.Http.get op read(): Payload;
`;

const reservedRuntimeIdentifiers = [
  "Ctx",
  "Decoder",
  "ServerOperation",
  "Either",
  "createHints",
  "emptyHints",
  "ResponseEncoders",
  "Decoders",
  "RequestDecoders",
  "Validators",
  "decodeRequestInput",
  "decodeRequestInputAndBody",
  "decodeBody",
  "ServerHints",
  "MatchedRequestContext",
  "OperationHandler",
] as const;

const reservedRuntimeIdentifierSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "ReservedRuntimeIdentifierApi" })
namespace ReservedRuntimeIdentifierApi {
  ${reservedRuntimeIdentifiers.map((name) => `model ${name} { value: string; }`).join("\n  ")}

  model Payload {
    ${reservedRuntimeIdentifiers.map((name, index) => `value${index}: ${name};`).join("\n    ")}
  }

  @route("/payload")
  @post op create(@body body: Payload): Payload;

  @route("/context")
  @get op readContext(): MatchedRequestContext;

  @route("/handler")
  @get op readHandler(): OperationHandler;

  @route("/ctx")
  @get op readCtx(): Ctx;
}
`;

describe("generated name collisions", () => {
  test("qualifies colliding types, interfaces, operations, and operation IDs", () => {
    const r = compileFixture("name-collisions", collisionSpec);
    const models = r.readFile("collision-api", "models.ts");
    const server = r.readFile("collision-api", "server.ts");
    const operations = r.readFile("collision-api", "server-operations.ts");
    const router = r.readFile("collision-api", "server-router.ts");

    for (const declaration of [
      "export interface Sales_Item",
      "export interface Support_Item",
      "export type Sales_Category",
      "export type Support_Category",
      "export type Sales_Choice<T>",
      "export type Support_Choice<T>",
      "export type Sales_State",
      "export type Support_State",
      "export type Sales_Label<Name extends string>",
      "export type Support_Label<Name extends string>",
      "export type Sales_Token = string",
      "export type Support_Token = string",
    ]) {
      expect(models).toContain(declaration);
    }
    expect(models).toContain("sales: Sales_Item;");
    expect(models).toContain("support: Support_Item;");
    expect(models).toContain("salesChoice: Sales_Choice<Sales_Item>;");
    expect(models).toContain("supportChoice: Support_Choice<Support_Item>;");
    expect(models).toContain("category: Sales_Category;");
    expect(models).toContain("category: Support_Category;");
    expect(models).toContain("state: Sales_State;");
    expect(models).toContain("state: Support_State;");
    expect(models).toContain('salesLabel: Sales_Label<"sales">;');
    expect(models).toContain('supportLabel: Support_Label<"support">;');
    expect(models).toContain("token: Sales_Token;");
    expect(models).toContain("token: Support_Token;");

    expect(server).toContain("export interface Sales_ItemsServer");
    expect(server).toContain("export interface Support_ItemsServer");
    expect(server).not.toContain("export interface ItemsServer");
    expect(server).toContain("readonly Sales_Items: Sales_ItemsServer<Ctx>");
    expect(server).toContain("readonly Support_Items: Support_ItemsServer<Ctx>");
    expect(server).toContain("readonly Sales_status: OperationHandler");
    expect(server).toContain("readonly Support_status: OperationHandler");

    expect(operations).toContain("export const Sales_ItemsOperations");
    expect(operations).toContain("export const Support_ItemsOperations");
    expect(operations).toContain('operationId: "CollisionApi.Sales.Items.read"');
    expect(operations).toContain('operationId: "CollisionApi.Support.Items.read"');
    expect(operations).toContain('operationId: "CollisionApi.Sales.status"');
    expect(operations).toContain('operationId: "CollisionApi.Support.status"');
    expect(operations).toContain('operationId: "CollisionApi.pair"');
    expect(operations).not.toContain('operationId: "Items.read"');
    expect(operations).not.toContain('operationId: "CollisionApi.status"');

    expect(router).toContain("implementation.Sales_Items.read");
    expect(router).toContain("implementation.Support_Items.read");
    expect(router).toContain("implementation.Sales_status");
    expect(router).toContain("implementation.Support_status");
    r.typecheck("collision-api");
  });

  test("keeps interface and standalone group declarations distinct", () => {
    const r = compileFixture("group-name-collisions", groupCollisionSpec);
    const operations = r.readFile("group-api", "server-operations.ts");

    expect(operations).toContain("export const GroupApiOperations");
    expect(operations).toContain("export const GroupApi_InterfaceOperations");
    r.typecheck("group-api");
  });

  test("treats built-in leaf names according to semantic identity", () => {
    const r = compileFixture("builtin-leaf-names", builtinLeafNameSpec);
    const models = r.readFile("builtin-leaf-name-api", "models.ts");
    const operations = r.readFile("builtin-leaf-name-api", "server-operations.ts");
    const server = r.readFile("builtin-leaf-name-api", "server.ts");

    expect(models).toContain("export interface Model_Array<T>");
    expect(models).toContain("export interface Model_Record<T>");
    expect(models).toContain("export interface Model_File");
    expect(models).toContain("export interface HttpPart<T>");
    expect(models).toContain("array: Model_Array<string>;");
    expect(models).toContain("record: Model_Record<string>;");
    expect(models).toContain("file: Model_File;");
    expect(models).toContain("part: HttpPart<string>;");
    expect(operations).toContain(
      'import type { HttpPart, Model_Array, Model_File, Model_Record, Payload } from "./models.js";',
    );
    for (const name of ["HttpPart", "Model_Array", "Model_File", "Model_Record", "Payload"]) {
      expect(server).toContain(name);
    }
    r.typecheck("builtin-leaf-name-api");
  });

  test("uses the normalized service name for global namespace collision fallbacks", () => {
    const r = compileFixture("global-service-name-fallback", globalServiceNameFallbackSpec);
    const models = r.readFile("service", "models.ts");

    expect(models).toContain("export interface Service_Model_File_Model");
    expect(models).toContain("export interface Model_File");
    expect(models).toContain("first: Service_Model_File_Model;");
    expect(models).toContain("second: Model_File;");
    expect(models).not.toContain("export interface _Model_File_Model");
    r.typecheck("service");
  });

  test("reserves identifiers claimed by generated server modules", () => {
    const r = compileFixture("reserved-runtime-identifiers", reservedRuntimeIdentifierSpec);
    const models = r.readFile("reserved-runtime-identifier-api", "models.ts");
    const operations = r.readFile("reserved-runtime-identifier-api", "server-operations.ts");
    const server = r.readFile("reserved-runtime-identifier-api", "server.ts");

    for (const name of reservedRuntimeIdentifiers) {
      const generatedName = `Model_${name}`;
      expect(models).toContain(`export interface ${generatedName}`);
      expect(operations).toContain(generatedName);
    }
    for (const name of ["MatchedRequestContext", "OperationHandler", "Ctx"]) {
      expect(server).toContain(`Model_${name}`);
    }
    r.typecheck("reserved-runtime-identifier-api");
  });
});
