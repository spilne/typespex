import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildEmitter,
  cleanupFixtures,
  compileFixture,
  compileFixtureExpectingDiagnostics,
} from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const jsonWireSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "JsonWireApi" })
namespace JsonWireApi;

model Profile {
  @encodedName("application/json", "display_name")
  displayName: string;
}

model User {
  @encodedName("application/json", "user_id")
  userId: string;
  profile: Profile;
  aliases: Profile[];
  directory: Record<Profile>;

  @encodedName("application/json", "optional_profile")
  optionalProfile?: Profile;

  @encodedName("application/json", "nullable_profile")
  nullableProfile: Profile | null;
}

model UserEnvelope {
  @header("x-request-id") requestId: string;
  @body body: User;
}

model Tree {
  @encodedName("application/json", "node_label")
  label: string;
  child?: Tree;
}

model RecursiveA {
  b?: RecursiveB;
  @encodedName("application/json", "a_value") value: string;
}

model RecursiveB {
  a: RecursiveA;
}

@route("/users")
@post
op roundTrip(@body body: User): User;

@route("/users/envelope")
@get
op envelope(): UserEnvelope;

@route("/trees")
@post
op tree(@body body: Tree): Tree;

// Keep A before B: transform detection must not cache B as unchanged while A
// is still being traversed.
@route("/recursive-a")
@get
op recursiveA(): RecursiveA;

@route("/recursive-b")
@get
op recursiveB(): RecursiveB;
`;

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("JSON wire transforms", () => {
  test("decodes and serializes encoded names throughout JSON payload graphs", async () => {
    const result = compileFixture("json-wire-transforms", jsonWireSpec);
    const operations = result.readFile("json-wire-api", "server-operations.ts");

    expect(operations).toContain("JsonSerializers");
    expect(operations).toContain('userId: "user_id"');
    expect(operations).toContain('displayName: "display_name"');
    expect(operations).toContain('wireName: "optional_profile"');
    expect(operations).toContain("JsonSerializers.array(");
    expect(operations).toContain("JsonSerializers.record(");
    expect(operations).toContain("JsonSerializers.nullable(");
    expect(operations).toMatch(/JsonSerializers\.lazy<Tree>/);
    expect(operations).not.toContain("ignored-encoded-name");
    result.typecheck("json-wire-api");

    const { createJsonWireApiServerRouter } = await import(
      `${result.outputDir}/json-wire-api/server-router.ts`
    );
    let receivedUser: unknown;
    let receivedTree: unknown;
    const handlerUser = {
      userId: "u-1",
      profile: { displayName: "Primary" },
      aliases: [{ displayName: "Alias" }],
      directory: { admin: { displayName: "Administrator" } },
      optionalProfile: { displayName: "Optional" },
      nullableProfile: null,
    };
    const router = createJsonWireApiServerRouter({
      roundTrip: (input: unknown) => {
        receivedUser = input;
        return input;
      },
      envelope: () => ({ requestId: "r-1", body: handlerUser }),
      recursiveA: () => ({ value: "a" }),
      recursiveB: () => ({ a: { value: "nested" } }),
      tree: (input: unknown) => {
        receivedTree = input;
        return input;
      },
    } as any);

    const userWire = {
      user_id: "u-1",
      profile: { display_name: "Primary" },
      aliases: [{ display_name: "Alias" }],
      directory: { admin: { display_name: "Administrator" } },
      optional_profile: { display_name: "Optional" },
      nullable_profile: null,
    };
    const roundTrip = await router.handle(jsonRequest("/users", userWire));
    expect(roundTrip.status).toBe(200);
    expect(receivedUser).toEqual(handlerUser);
    expect(await roundTrip.json()).toEqual(userWire);

    const envelope = await router.handle(new Request("http://localhost/users/envelope"));
    expect(envelope.status).toBe(200);
    expect(envelope.headers.get("x-request-id")).toBe("r-1");
    expect(await envelope.json()).toEqual(userWire);

    const treeWire = {
      node_label: "root",
      child: { node_label: "leaf" },
    };
    const tree = await router.handle(jsonRequest("/trees", treeWire));
    expect(tree.status).toBe(200);
    expect(receivedTree).toEqual({ label: "root", child: { label: "leaf" } });
    expect(await tree.json()).toEqual(treeWire);

    const recursiveB = await router.handle(new Request("http://localhost/recursive-b"));
    expect(recursiveB.status).toBe(200);
    expect(await recursiveB.json()).toEqual({ a: { a_value: "nested" } });
  });

  test("rejects nested transformed response unions that cannot be distinguished", () => {
    const result = compileFixtureExpectingDiagnostics(
      "json-wire-ambiguous-union",
      `
      import "@typespec/http";
      using TypeSpec.Http;

      @service namespace AmbiguousJsonWireApi {
        model Left {
          @encodedName("application/json", "left_value") value: string;
        }
        model Right {
          @encodedName("application/json", "right_value") value: string;
        }
        model Wrapper { choice: Left | Right; }

        @route("/value") @get op read(): Wrapper;
      }
    `,
    );

    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;
    expect(diagnostics).toContain("unsupported-json-serialization");
    expect(diagnostics).toContain('operation "read"');
    expect(diagnostics).toContain("multiple wire-transforming variants");
    expect(result.listFiles("ambiguous-json-wire-api")).toEqual([]);
  });
});
