import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildEmitter, cleanupFixtures, compileFixture } from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const standaloneSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "StatusApi" })
namespace StatusApi;

model HealthStatus { ok: boolean; }

@route("/health")
@get op health(): HealthStatus;
`;

const nestedSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "NestedApi" })
namespace NestedApi;

namespace Admin {
  model Config { key: string; value: string; }

  @route("/admin/config")
  @get op getConfig(): Config;
}
`;

const hintsSpec = `
import "@typespec/http";
import "./lib.js";

using TypeSpec.Http;
using TypeSpec.Reflection;

extern dec auth(target: Operation, scope: valueof string);

@service(#{ title: "SecureApi" })
namespace SecureApi {
  @route("/admin")
  @get @auth("admin")
  op admin(): string;
}
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("operation structures", () => {
  test("standalone operations — no interface wrapper", () => {
    const r = compileFixture("standalone", standaloneSpec);

    expect(r.readFile("status-api", "server.ts")).toMatchSnapshot();
    expect(r.readFile("status-api", "server-operations.ts")).toMatchSnapshot();
    expect(r.readFile("status-api", "server-router.ts")).toMatchSnapshot();
  });

  test("nested namespaces carry namespace metadata", () => {
    const r = compileFixture("nested", nestedSpec);

    expect(r.readFile("nested-api", "server-operations.ts")).toMatchSnapshot();
  });

  test("custom decorator hints for middleware", () => {
    const r = compileFixture("hints", hintsSpec, "", {
      "lib.js": "export function $auth() {}",
    });

    expect(r.readFile("secure-api", "server-hints.ts")).toMatchSnapshot();
    expect(r.readFile("secure-api", "server-operations.ts")).toMatchSnapshot();
  });
});
