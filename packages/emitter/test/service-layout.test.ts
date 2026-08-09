import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolvePath } from "@typespec/compiler";
import {
  buildEmitter,
  cleanupFixtures,
  compileFixture,
  compileFixtureExpectingDiagnostics,
} from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const multiServiceSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "Public API" })
namespace PublicApi {
  model Item { id: string; }
  @route("/items") @get op listItems(): Item[];
}

@service(#{ title: "Admin API" })
namespace AdminApi {
  model User { id: string; }
  @route("/users") @get op listUsers(): User[];
}
`;

const billingSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "Billing API" })
namespace BillingAPI {
  model Invoice { id: string; }
  @route("/invoices") @get op listInvoices(): Invoice[];
}
`;

const duplicateLeafServiceSpec = `
import "@typespec/http";
using TypeSpec.Http;

namespace Sales {
  @service namespace Api {
    @route("/orders") @get op listOrders(): string[];
  }
}

namespace Support {
  @service namespace Api {
    @route("/tickets") @get op listTickets(): string[];
  }
}
`;

const generatedArtifacts = [
  ["models", "models.ts"],
  ["server-hints", "server-hints.ts"],
  ["server-operations", "server-operations.ts"],
  ["server", "server.ts"],
  ["server-router", "server-router.ts"],
] as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("service layout", () => {
  test("emits the complete generated artifact set", () => {
    const r = compileFixture("complete-artifact-set", billingSpec);

    expect(r.listFiles("billing-api")).toEqual(
      generatedArtifacts.map(([, fileName]) => fileName).sort(),
    );
  });

  test("multiple services — per-service directories (default)", () => {
    const r = compileFixture("multi-dir", multiServiceSpec);

    expect(r.fileExists("server.ts")).toBe(false);
    expect(r.fileExists("public-api", "server.ts")).toBe(true);
    expect(r.fileExists("admin-api", "server.ts")).toBe(true);

    expect(r.readFile("public-api", "server-router.ts")).toMatchSnapshot();
    expect(r.readFile("admin-api", "server-router.ts")).toMatchSnapshot();
  });

  test("multiple services — prefixed files", () => {
    const r = compileFixture("multi-prefix", multiServiceSpec, "    service-output: prefix\n");

    expect(r.fileExists("PublicApi.server.ts")).toBe(true);
    expect(r.fileExists("AdminApi.server.ts")).toBe(true);

    expect(r.readFile("PublicApi.server-operations.ts")).toMatchSnapshot();
    expect(r.readFile("PublicApi.server-router.ts")).toMatchSnapshot();
  });

  test("custom folder and file name patterns", () => {
    const r = compileFixture(
      "name-patterns",
      billingSpec,
      '    service-folder-pattern: "{service.kebab}-generated"\n    file-name-pattern: "{file}.gen"\n',
    );

    const dir = "billing-api-generated";
    expect(r.fileExists(dir, "models.gen.ts")).toBe(true);
    expect(r.fileExists(dir, "server.gen.ts")).toBe(true);
    expect(r.fileExists(dir, "server-operations.gen.ts")).toBe(true);

    expect(r.readFile(dir, "server-operations.gen.ts")).toMatchSnapshot();
    expect(r.readFile(dir, "server-router.gen.ts")).toMatchSnapshot();
  });

  test("keeps dot-segment folder patterns inside the emitter output directory", () => {
    for (const [name, pattern, safeDirectory] of [
      ["current", ".", "_"],
      ["parent", "..", "__"],
    ] as const) {
      const r = compileFixture(
        `safe-${name}-segment-folder`,
        billingSpec,
        `    service-folder-pattern: "${pattern}"\n`,
      );

      expect(r.listFiles(safeDirectory)).toEqual(
        generatedArtifacts.map(([, fileName]) => fileName).sort(),
      );
      expect(r.fileExists(pattern, "models.ts")).toBe(false);
    }
  });

  test("rejects layouts that overwrite another service", () => {
    const r = compileFixtureExpectingDiagnostics(
      "multi-flat-collision",
      multiServiceSpec,
      "    service-output: flat\n",
    );
    const diagnostics = `${r.diagnostics.stdout}\n${r.diagnostics.stderr}`;

    expect(diagnostics).toContain("duplicate-output-path");
    expect(diagnostics).toContain('"PublicApi.models"');
    expect(diagnostics).toContain('"AdminApi.models"');
    expect(diagnostics).toContain(resolvePath(r.outputDir, "models.ts"));
    expect(r.fileExists("server.ts")).toBe(false);
  });

  test("identifies colliding services by full namespace name", () => {
    const r = compileFixtureExpectingDiagnostics(
      "nested-service-collision",
      duplicateLeafServiceSpec,
    );
    const diagnostics = `${r.diagnostics.stdout}\n${r.diagnostics.stderr}`;

    expect(diagnostics).toContain('"Sales.Api.models"');
    expect(diagnostics).toContain('"Support.Api.models"');
    expect(r.listFiles("api")).toEqual([]);
  });

  test("rejects custom patterns that collapse files within one service", () => {
    const r = compileFixtureExpectingDiagnostics(
      "single-service-file-collision",
      billingSpec,
      '    file-name-pattern: "generated"\n',
    );
    const diagnostics = `${r.diagnostics.stdout}\n${r.diagnostics.stderr}`;

    expect(diagnostics).toContain("duplicate-output-path");
    for (const [artifact] of generatedArtifacts) {
      expect(diagnostics).toContain(`"BillingAPI.${artifact}"`);
    }
    expect(r.fileExists("billing-api", "generated.ts")).toBe(false);
  });
});
