import { describe, expect, test } from "bun:test";
import { createTestHost, createTestRunner } from "@typespec/compiler/testing";
import { getAllHttpServices } from "@typespec/http";
import { HttpTestLibrary } from "@typespec/http/testing";
import { createEmitterContext } from "../src/ctx.js";
import { renderServerOperations } from "../src/render-server-operations.js";
import { renderServerRouter } from "../src/render-server-router.js";
import { renderServer } from "../src/render-server.js";
import { getPayloadTypeAliasDeclarations } from "../src/payload-context.js";
import { buildServerPlan, type ServerPlan } from "../src/server-plan.js";

describe("server planning", () => {
  test("captures every handler payload alias before rendering begins", async () => {
    const host = await createTestHost({ libraries: [HttpTestLibrary] });
    const runner = await createTestRunner(host);
    const [, diagnostics] = await runner.compileAndDiagnose(`
      using TypeSpec.Http;

      @service namespace AliasApi {
        model Pet { id: string; }

        @error model NotFound {
          @statusCode _: 404;
          code: "NOT_FOUND";
          cause?: NotFound;
        }

        @get @route("/pets/{id}")
        op read(@path id: string): Pet | NotFound;
      }
    `);
    expect(diagnostics).toHaveLength(0);

    const [services, httpDiagnostics] = getAllHttpServices(runner.program);
    expect(httpDiagnostics).toHaveLength(0);
    const service = services[0];
    if (!service) throw new Error("Expected an HTTP service.");

    const ctx = createEmitterContext(runner.program, service, {});
    const plan = buildServerPlan(ctx, service.operations);
    const serverBeforeOperations = renderServer(plan);

    expect(plan.handlerPayloadTypeAliases.length).toBeGreaterThan(0);
    expect(missingPayloadAliasDeclarations(serverBeforeOperations)).toEqual([]);

    renderServerOperations(plan);

    expect(getPayloadTypeAliasDeclarations(ctx)).toEqual(plan.operationPayloadTypeAliases);
    expect(renderServer(plan)).toBe(serverBeforeOperations);
  });

  test("renders a cloned plan repeatably and in any artifact order", async () => {
    const host = await createTestHost({ libraries: [HttpTestLibrary] });
    const runner = await createTestRunner(host);
    const [, diagnostics] = await runner.compileAndDiagnose(`
      using TypeSpec.Http;

      @service namespace PlanningApi {
        model Owner { name: string; }
        model Pet { id: string; owner: Owner; }

        @get @route("/pets/{id}")
        op read(@path id: string): Pet;
      }
    `);
    expect(diagnostics).toHaveLength(0);

    const [services, httpDiagnostics] = getAllHttpServices(runner.program);
    expect(httpDiagnostics).toHaveLength(0);
    const service = services[0];
    if (!service) throw new Error("Expected an HTTP service.");

    const ctx = createEmitterContext(runner.program, service, {});
    const plan = buildServerPlan(ctx, service.operations);
    const cloned = structuredClone(plan);
    const expected = renderArtifacts(plan, ["server", "operations", "router"]);

    expect(plan.operationModelImports).toEqual(["Owner", "Pet"]);
    expect(plan.handlerModelImports).toEqual(["Pet"]);
    expect(Object.keys(plan.groups[0]!.operations[0]!)).not.toContain("httpOperation");
    expect(renderArtifacts(cloned, ["router", "operations", "server"])).toEqual(expected);
    expect(renderArtifacts(cloned, ["server", "operations", "router"])).toEqual(expected);
    expect(renderArtifacts(cloned, ["server", "operations", "router"])).toEqual(expected);
  });

  test("rebuilds a plan without retaining aliases from the previous build", async () => {
    const host = await createTestHost({ libraries: [HttpTestLibrary] });
    const runner = await createTestRunner(host);
    const [, diagnostics] = await runner.compileAndDiagnose(`
      using TypeSpec.Http;

      @service namespace RepeatApi {
        model Owner { name: string; }

        @error model NotFound {
          @statusCode _: 404;
          owner: Owner;
          cause?: NotFound;
        }

        @get @route("/pets/{id}")
        op read(@path id: string): NotFound;
      }
    `);
    expect(diagnostics).toHaveLength(0);

    const [services, httpDiagnostics] = getAllHttpServices(runner.program);
    expect(httpDiagnostics).toHaveLength(0);
    const service = services[0];
    if (!service) throw new Error("Expected an HTTP service.");

    const ctx = createEmitterContext(runner.program, service, {});
    const first = buildServerPlan(ctx, service.operations);
    const second = buildServerPlan(ctx, service.operations);

    expect(second).toEqual(first);
    expect(renderArtifacts(second, ["router", "server", "operations"])).toEqual(
      renderArtifacts(first, ["server", "operations", "router"]),
    );
  });
});

type ArtifactName = "server" | "operations" | "router";

function renderArtifacts(
  plan: ServerPlan,
  order: readonly ArtifactName[],
): Record<ArtifactName, string> {
  const artifacts: Partial<Record<ArtifactName, string>> = {};
  for (const artifact of order) {
    artifacts[artifact] =
      artifact === "server"
        ? renderServer(plan)
        : artifact === "operations"
          ? renderServerOperations(plan)
          : renderServerRouter(plan);
  }
  return {
    server: artifacts.server!,
    operations: artifacts.operations!,
    router: artifacts.router!,
  };
}

function missingPayloadAliasDeclarations(source: string): string[] {
  const referenced = new Set(
    [...source.matchAll(/\b(_TypespexPayload_[A-Za-z0-9_]+)\b/g)].map((match) => match[1]!),
  );
  const declared = new Set(
    [...source.matchAll(/^type (_TypespexPayload_[A-Za-z0-9_]+)\b/gm)].map((match) => match[1]!),
  );
  return [...referenced].filter((name) => !declared.has(name)).sort();
}
