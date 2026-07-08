import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildEmitter,
  cleanupFixtures,
  compileFixtureCollectingDiagnostics,
  compileFixtureExpectingDiagnostics,
} from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const header = (title: string) => `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "${title}" })
namespace ${title};
`;

const encodeSpec = `${header("EncodeApi")}
model Event {
  @encode("unixTimestamp", int32)
  createdAt: utcDateTime;
}

@route("/events")
interface Events {
  @post create(@body body: Event): Event;
}
`;

const encodedNameSpec = `${header("EncodedNameApi")}
model User {
  @encodedName("application/json", "user_name")
  userName: string;
}

@route("/users")
interface Users {
  @post create(@body body: User): User;
}
`;

const discriminatedSpec = `${header("DiscriminatedApi")}
model Cat { meows: boolean; }
model Dog { barks: boolean; }

@discriminated
union Pet { cat: Cat, dog: Dog }

@route("/pets")
interface Pets {
  @post adopt(@body body: Pet): Cat;
}
`;

const visibilitySpec = `${header("VisibilityApi")}
model Item {
  @visibility(Lifecycle.Read)
  id: string;
  name: string;
}

@route("/items")
interface Items {
  @post create(@body body: Item): Item;
}
`;

const authSpec = `${header("AuthApi")}
model Item { id: string; }

@useAuth(BearerAuth)
@route("/items")
interface Items {
  @get list(): Item[];
}
`;

// A spec using none of the ignored decorators — including a plain
// utcDateTime, which must NOT trip the @encode diagnostic.
const cleanSpec = `${header("CleanApi")}
model Item {
  id: string;
  createdAt: utcDateTime;
}

@route("/items")
interface Items {
  @get list(): Item[];
}
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ignored decorator diagnostics", () => {
  test("@encode reports ignored-encode", () => {
    const r = compileFixtureExpectingDiagnostics("diag-encode", encodeSpec);

    const combined = `${r.diagnostics.stdout}\n${r.diagnostics.stderr}`;
    expect(combined).toContain("ignored-encode");
    expect(combined).toContain("createdAt");
  });

  test("@encodedName reports ignored-encoded-name", () => {
    const r = compileFixtureExpectingDiagnostics("diag-encoded-name", encodedNameSpec);

    const combined = `${r.diagnostics.stdout}\n${r.diagnostics.stderr}`;
    expect(combined).toContain("ignored-encoded-name");
    expect(combined).toContain("userName");
  });

  test("@discriminated reports ignored-discriminated", () => {
    const r = compileFixtureExpectingDiagnostics("diag-discriminated", discriminatedSpec);

    const combined = `${r.diagnostics.stdout}\n${r.diagnostics.stderr}`;
    expect(combined).toContain("ignored-discriminated");
    expect(combined).toContain("Pet");
  });

  test("@visibility reports ignored-visibility warning", () => {
    const r = compileFixtureCollectingDiagnostics("diag-visibility", visibilitySpec);

    const combined = `${r.diagnostics.stdout}\n${r.diagnostics.stderr}`;
    expect(combined).toContain("ignored-visibility");
    expect(combined).toContain("id");
  });

  test("@useAuth reports ignored-auth warning once", () => {
    const r = compileFixtureCollectingDiagnostics("diag-auth", authSpec);

    const combined = `${r.diagnostics.stdout}\n${r.diagnostics.stderr}`;
    expect(combined).toContain("ignored-auth");
  });

  test("specs without ignored decorators stay silent", () => {
    const r = compileFixtureCollectingDiagnostics("diag-clean", cleanSpec);

    const combined = `${r.diagnostics.stdout}\n${r.diagnostics.stderr}`;
    expect(combined).not.toContain("ignored-encode");
    expect(combined).not.toContain("ignored-encoded-name");
    expect(combined).not.toContain("ignored-discriminated");
    expect(combined).not.toContain("ignored-visibility");
    expect(combined).not.toContain("ignored-auth");
  });
});
