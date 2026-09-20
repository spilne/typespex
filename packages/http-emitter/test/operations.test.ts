import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildEmitter, cleanupFixtures, compileFixture } from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter, 120_000);

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

const escapingSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "EscapingApi" })
namespace EscapingApi;

model EscapedModel {
  "default": string;
  "x-request-id": string;
  "readonly"?: string;
  "__proto__"?: string;
}

@route("/escaped")
interface Items {
  @get delete(): EscapedModel;

  @post create(
    @query("default") defaultValue?: string,
    @body body: EscapedModel,
  ): EscapedModel;
}
`;

const moduleReservedIdentifierSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "AwaitIdentifiersApi" })
namespace AwaitIdentifiersApi;

model await {
  await: string;
}

@route("/await")
interface AwaitOperations {
  @post op await(
    @query await: string,
    @body body: await,
  ): await;
}
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("operation structures", () => {
  test("path-only operations keep narrow decoder inputs through mappings and combinations", () => {
    const r = compileFixture(
      "path-only-input",
      `
import "@typespec/http";
using TypeSpec.Http;
@service namespace PathOnlyApi;
@route("/items/{name}") @get op read(@path name: string): string;
@route("/items/{name}/{ids}") @get op list(@path name: string, @path ids: int32[]): string;
@route("/mixed/{name}") @get op mixed(@path name: string, @query filter: string): string;
`,
    );
    const operations = r.readFile("path-only-api", "server-operations.ts");
    expect(operations).toContain("decodePathInput<{ name: string }>");
    expect(operations).toContain("decodePathInput<{ name: string; ids: number[] }>");
    expect(operations).toContain("decodeRequestInput<{ name: string; filter: string }>");
    expect(operations.match(/decodeNativePathInput:/g)).toHaveLength(1);
    r.typecheck("path-only-api", {
      "path-input-types.ts": `
import { Decoders, RequestDecoders, decodePathInput } from "@typespex/http-server";
const path = RequestDecoders.path("id", Decoders.string).map(id => ({ id }));
decodePathInput(path.decode, { id: "encoded%20id" });
path.decode({ pathParams: {}, query: new URLSearchParams(), headers: new Headers(), cookies: {} });
const query = RequestDecoders.query("limit", Decoders.integer);
// @ts-expect-error Query decoders need more than path captures.
decodePathInput(query.decode, {});
const mixed = RequestDecoders.combine([path, query], (path, limit) => ({ ...path, limit }));
// @ts-expect-error A mixed combination still requires the full request source.
decodePathInput(mixed.decode, {});
`,
    });
  });

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

  test("escapes TypeScript identifiers and property names", () => {
    const r = compileFixture("escaping", escapingSpec);

    expect(r.readFile("escaping-api", "models.ts")).toMatchSnapshot();
    expect(r.readFile("escaping-api", "server.ts")).toMatchSnapshot();
    expect(r.readFile("escaping-api", "server-operations.ts")).toMatchSnapshot();
    expect(r.readFile("escaping-api", "server-router.ts")).toMatchSnapshot();
  });

  test("escapes await across generated declarations and operation surfaces", () => {
    const r = compileFixture("await-identifiers", moduleReservedIdentifierSpec);

    r.typecheck("await-identifiers-api");
    expect(r.readFile("await-identifiers-api", "models.ts")).toContain("export interface await_");
    expect(r.readFile("await-identifiers-api", "models.ts")).toContain("await: string;");
    expect(r.readFile("await-identifiers-api", "server-operations.ts")).toContain(
      'RequestDecoders.query("await"',
    );
  });
});
