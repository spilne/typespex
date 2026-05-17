import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildEmitter, cleanupFixtures, compileFixture } from "./compile-fixture.js";

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("service layout", () => {
  test("multiple services — per-service directories (default)", () => {
    const r = compileFixture("multi-dir", multiServiceSpec);

    expect(r.fileExists("server.ts")).toBe(false);
    expect(r.fileExists("public-api", "server.ts")).toBe(true);
    expect(r.fileExists("admin-api", "server.ts")).toBe(true);

    expect(r.readFile("public-api", "server-router.ts")).toMatchSnapshot();
    expect(r.readFile("admin-api", "server-router.ts")).toMatchSnapshot();
  });

  test("multiple services — prefixed files", () => {
    const r = compileFixture(
      "multi-prefix",
      multiServiceSpec,
      '    service-output: prefix\n',
    );

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
});
