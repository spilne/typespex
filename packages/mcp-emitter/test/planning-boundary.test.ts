import { describe, expect, test } from "bun:test";
import type { EmitContext } from "@typespec/compiler";
import { createTestHost, createTestRunner } from "@typespec/compiler/testing";
import { HttpTestLibrary } from "@typespec/http/testing";
import {
  COMPILER_PLAN_VERSION,
  type JsonWirePlan,
  type OperationPlan,
  type ServicePlan,
} from "@typespex/compiler-core/unstable";
import { createServerArtifacts } from "../src/artifacts.js";
import type { McpEmitterOptions } from "../src/lib.js";
import { loadBridgePlanningContext, planServer } from "../src/planning.js";
import { planSchemaDocument } from "../src/schema-document-planner.js";
import type { PlannedServer, PlannedTool } from "../src/types.js";

describe("MCP planning boundary", () => {
  test("renders a real planned HTTP bridge repeatably after cloning", async () => {
    const host = await createTestHost({ libraries: [HttpTestLibrary] });
    const runner = await createTestRunner(host);
    const [, diagnostics] = await runner.compileAndDiagnose(`
      using TypeSpec.Http;

      model Pet { id: string; name: string; }

      @service(#{ title: "Pet API" })
      @server("https://api.example.test")
      namespace PetApi {
        @get @route("/pets/{id}")
        op getPet(@path id: string, @query verbose?: boolean): Pet;
      }
    `);
    expect(
      diagnostics
        .filter((diagnostic) => diagnostic.severity === "error")
        .map((diagnostic) => diagnostic.message),
    ).toEqual([]);

    const namespace = runner.program.getGlobalNamespaceType().namespaces.get("PetApi");
    const operation = namespace?.operations.get("getPet");
    if (!namespace || !operation) throw new Error("Expected the PetApi.getPet operation.");

    const context: EmitContext<McpEmitterOptions> = {
      program: runner.program,
      emitterOutputDir: "generated",
      options: { mode: ["native", "http-bridge"], launchers: [] },
      perf: {
        startTimer: () => ({ end: () => 0 }),
        time: (_label, callback) => callback(),
        timeAsync: (_label, callback) => callback(),
        report: () => {},
      },
    };
    const bridge = await loadBridgePlanningContext(context);
    if (!bridge) throw new Error("Expected HTTP bridge planning support.");

    const server = planServer(
      context,
      { namespace, version: "1.0.0" },
      [{ operation }],
      { native: true, httpBridge: true },
      bridge,
      undefined,
    );
    expect(server.tools[0]?.http).toBeDefined();

    const cloned = structuredClone(server);
    const originalArtifacts = createServerArtifacts(server, []);
    const firstCloneArtifacts = createServerArtifacts(cloned, []);
    const secondCloneArtifacts = createServerArtifacts(cloned, []);
    const httpBridge = firstCloneArtifacts.find((artifact) =>
      artifact.artifact.endsWith(".mcp-http-bridge"),
    );

    expect(firstCloneArtifacts).toEqual(originalArtifacts);
    expect(secondCloneArtifacts).toEqual(firstCloneArtifacts);
    expect(httpBridge?.content).toContain('"method":"GET"');
    expect(httpBridge?.content).toContain('"path":"/pets/{id}"');
  });

  test("renders repeatably from a cloned data-only plan", () => {
    const input: JsonWirePlan = {
      version: COMPILER_PLAN_VERSION,
      schema: { type: "object" },
      semanticType: '{ Phantom: string; value: Pet; literal: "Phantom" }',
      wireType: '{ Phantom: string; value: Pet; literal: "Phantom" }',
      referencedTypes: ["Pet"],
    };
    const server = createPlanningFixture(input);

    const cloned = structuredClone(server);
    const first = createServerArtifacts(cloned, []);
    const second = createServerArtifacts(cloned, []);
    const operations = first.find((artifact) => artifact.artifact === "Test.mcp-operations");

    expect(second).toEqual(first);
    expect(operations?.content).toContain('import type { Pet } from "./models.js";');
    expect(operations?.content).not.toContain("import type { Pet, Phantom }");
  });

  test("keeps version 1 plans without structural references renderable", () => {
    const server = createPlanningFixture({
      version: COMPILER_PLAN_VERSION,
      schema: { type: "object" },
      semanticType: "Pet",
      wireType: "Pet",
    });

    const operations = createServerArtifacts(server, []).find(
      (artifact) => artifact.artifact === "Test.mcp-operations",
    );

    expect(operations?.content).toContain('import type { Pet, Phantom } from "./models.js";');
  });
});

function createPlanningFixture(input: JsonWirePlan): PlannedServer {
  const operation: OperationPlan = {
    version: COMPILER_PLAN_VERSION,
    name: "inspect",
    input,
  };
  const service: ServicePlan = {
    version: COMPILER_PLAN_VERSION,
    name: "Test",
    namespace: "Test",
    types: [
      {
        version: COMPILER_PLAN_VERSION,
        key: "Pet",
        name: "Pet",
        semanticType: "Pet",
        wireType: "Pet",
      },
      {
        version: COMPILER_PLAN_VERSION,
        key: "Phantom",
        name: "Phantom",
        semanticType: "Phantom",
        wireType: "Phantom",
      },
    ],
    operations: [operation],
  };
  const tool: PlannedTool = {
    plan: operation,
    name: "inspect",
    symbolName: "Inspect",
    allowsVoid: true,
    requiresTaggedResult: false,
  };
  return {
    plan: service,
    modelModule: {
      banner: "// Generated by TypeSpex. Do not edit.",
      imports: [],
      declarations: [
        "export interface Pet { id: string; }",
        "export interface Phantom { id: string; }",
      ],
    },
    schemaDocument: planSchemaDocument([tool]),
    symbolName: "Test",
    outputDir: "test",
    fileNames: {
      models: "models",
      operations: "mcp-operations",
      server: "mcp-server",
      httpBridge: "mcp-http-bridge",
      stdio: "mcp-stdio",
      node: "mcp-node",
      bun: "mcp-bun",
      express: "mcp-express",
      hono: "mcp-hono",
    },
    tools: [tool],
    version: "1.0.0",
    modes: { native: true, httpBridge: false },
  };
}
