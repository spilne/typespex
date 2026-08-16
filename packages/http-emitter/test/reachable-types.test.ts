import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildEmitter, cleanupFixtures, compileFixture } from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const reachabilitySpec = `
import "@typespec/http";
using TypeSpec.Http;

namespace Shared {
  enum Kind {
    created: "created",
    updated: "updated",
  }

  scalar Label<Name extends valueof string> extends string;

  model Metadata {
    kind: Kind;
  }

  model Constraint {
    id: string;
  }

  model BaseNode {
    createdAt: string;
  }

  model Envelope<T extends Constraint = Constraint> {
    value: T;
    metadata: Metadata;
  }

  model UnusedExternal {
    ignored: string;
  }
}

@service(#{ title: "ReachableTypesApi" })
namespace ReachableTypesApi {
  enum Filter {
    active: "active",
    archived: "archived",
  }

  model Leaf {
    id: string;
  }

  union Selection {
    leaf: Leaf,
    label: Shared.Label<"leaf">,
  }

  model SharedNode extends Shared.BaseNode {
    selection: Selection;
    history: Shared.Envelope<Leaf>[];
    next?: SharedNode;
  }

  model CreateInput {
    filter: Filter;
    node: SharedNode;
    lookup: Record<Leaf>;
  }

  model CreateOutput {
    node: SharedNode;
  }

  model UnusedModel {
    child: UnusedChild;
    external: Shared.UnusedExternal;
  }

  model UnusedChild {
    value: string;
  }

  enum UnusedEnum {
    value,
  }

  union UnusedUnion {
    value: UnusedChild,
    empty: null,
  }

  scalar UnusedScalar<Name extends valueof string> extends string;

  namespace Nested {
    model NestedUnused {
      value: string;
    }
  }

  @route("/items")
  @post
  op create(@body body: CreateInput): CreateOutput;
}
`;

const emptySurfaceSpec = `
import "@typespec/http";

@service namespace EmptySurfaceApi {
  model NamespaceOnly {
    value: string;
  }
}
`;

describe("reachable-only named type emission", () => {
  test("keeps full service-namespace emission as the default", () => {
    const result = compileFixture("reachable-types-default", reachabilitySpec);
    const models = result.readFile("reachable-types-api", "models.ts");

    expect(models).toContain("export interface UnusedModel");
    expect(models).toContain("export interface UnusedChild");
    expect(models).toContain("export type UnusedEnum");
    expect(models).toContain("export type UnusedUnion");
    expect(models).toContain("export type UnusedScalar<Name extends string> = string;");
    expect(models).toContain("export interface NestedUnused");
    expect(models).toContain("export interface UnusedExternal");
    result.typecheck("reachable-types-api");
  });

  test("emits the complete operation-rooted closure once", () => {
    const result = compileFixture(
      "reachable-types-opt-in",
      reachabilitySpec,
      "    omit-unreachable-types: true\n",
    );
    const models = result.readFile("reachable-types-api", "models.ts");
    const server = result.readFile("reachable-types-api", "server.ts");

    for (const declaration of [
      "export type Filter",
      "export interface Leaf",
      "export type Selection",
      "export interface SharedNode",
      "export interface CreateInput",
      "export interface CreateOutput",
      "export type Kind",
      "export type Label<Name extends string> = string;",
      "export interface Metadata",
      "export interface Constraint",
      "export interface BaseNode",
      "export interface Envelope<T extends Constraint = Constraint>",
    ]) {
      expect(models).toContain(declaration);
    }

    expect(models.match(/export interface SharedNode/g)).toHaveLength(1);
    expect(models.match(/export interface Leaf/g)).toHaveLength(1);
    expect(models).not.toContain("UnusedModel");
    expect(models).not.toContain("UnusedChild");
    expect(models).not.toContain("UnusedEnum");
    expect(models).not.toContain("UnusedUnion");
    expect(models).not.toContain("UnusedScalar");
    expect(models).not.toContain("NestedUnused");
    expect(models).not.toContain("UnusedExternal");
    expect(server).toContain("OperationHandler<CreateInput, CreateOutput, Ctx>");
    result.typecheck("reachable-types-api");
  });

  test("omits namespace-only declarations when a service has no operations", () => {
    const result = compileFixture(
      "reachable-types-empty-surface",
      emptySurfaceSpec,
      "    omit-unreachable-types: true\n",
    );
    const models = result.readFile("empty-surface-api", "models.ts");

    expect(models).not.toContain("NamespaceOnly");
    expect(models).not.toContain("export ");
    result.typecheck("empty-surface-api");
  });
});
