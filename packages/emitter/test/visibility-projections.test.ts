import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildEmitter, cleanupFixtures, compileFixture } from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const lifecycleSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "VisibilityApi" })
namespace VisibilityApi;

model Nested {
  @visibility(Lifecycle.Read) readNested: string;
  @visibility(Lifecycle.Create) createNested: string;
  @visibility(Lifecycle.Update) updateNested: string;
  @visibility(Lifecycle.Create, Lifecycle.Update) writeNested: string;
  commonNested: string;
}

model Resource {
  @visibility(Lifecycle.Read) id: string;
  @visibility(Lifecycle.Create) createOnly: string;
  @visibility(Lifecycle.Update) updateOnly: string;
  @visibility(Lifecycle.Create, Lifecycle.Update) writeOnly: string;
  @removeVisibility(Lifecycle.Read) notRead: string;
  @invisible(Lifecycle) internal: string;
  name: string;
  nested: Nested;
  items: Nested[];
}

model CycleLeft {
  right: CycleRight;
  @visibility(Lifecycle.Read) readOnly: string;
}

model CycleRight {
  left?: CycleLeft;
}

@route("/resources")
@post
op create(@body body: Resource): Resource;

@route("/resources/{id}")
@put
op replace(@path id: string, @body body: Resource): Resource;

@route("/resources/{id}")
@patch(#{ implicitOptionality: true })
op update(@path id: string, @body body: Resource): Resource;

@route("/resources/{id}")
@get
op read(@path id: string): Resource;

@route("/cycles")
@post
op createCycle(@body body: CycleLeft): void;
`;

const overrideAndMetadataSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "VisibilityOverrideApi" })
namespace VisibilityOverrideApi;

model MetadataPayload {
  @visibility(Lifecycle.Create) @header("x-create-token") createToken: string;
  @visibility(Lifecycle.Read) @header("x-read-token") readToken: string;
  value: string;
}

model OverrideResource {
  @visibility(Lifecycle.Read) readOnly: string;
  @visibility(Lifecycle.Create) createOnly: string;
  common: string;
}

@route("/metadata")
@post
op submitMetadata(@bodyRoot body: MetadataPayload): MetadataPayload;

@route("/override")
@post
@parameterVisibility(Lifecycle.Read)
@returnTypeVisibility(Lifecycle.Create)
op override(@body body: OverrideResource): OverrideResource;
`;

const collidingNamesSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "VisibilityAliasApi" })
namespace VisibilityAliasApi {
  namespace Sales {
    model Item {
      @visibility(Lifecycle.Read) id: string;
      @visibility(Lifecycle.Create) secret: string;
      name: string;
    }

    @route("/sales")
    @post
    op create(@body body: Item): Item;
  }

  namespace Support {
    model Item {
      @visibility(Lifecycle.Read) id: string;
      @visibility(Lifecycle.Create) secret: string;
      name: string;
    }

    @route("/support")
    @post
    op create(@body body: Item): Item;
  }
}
`;

interface ProjectedAlias {
  readonly name: string;
  readonly body: string;
}

function projectedAliases(source: string, typeName: string): ProjectedAlias[] {
  const pattern = new RegExp(
    `type (_TypespexPayload_${typeName}_[A-Za-z0-9_]+) = \\{([\\s\\S]*?)\\n?\\};`,
    "g",
  );
  return [...source.matchAll(pattern)].map((match) => ({ name: match[1]!, body: match[2]! }));
}

function jsonRequest(method: string, path: string, body: unknown, headers = {}): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function responseResource() {
  return {
    id: "generated-id",
    createOnly: "create-secret",
    updateOnly: "update-secret",
    writeOnly: "write-secret",
    notRead: "not-read-secret",
    internal: "internal-secret",
    name: "visible-name",
    nested: {
      readNested: "nested-read",
      createNested: "nested-create",
      updateNested: "nested-update",
      writeNested: "nested-write",
      commonNested: "nested-common",
    },
    items: [
      {
        readNested: "item-read",
        createNested: "item-create",
        updateNested: "item-update",
        writeNested: "item-write",
        commonNested: "item-common",
      },
    ],
  };
}

describe("TypeSpec lifecycle visibility projections", () => {
  test("projects create, replace, update, and read shapes recursively", async () => {
    const result = compileFixture("visibility-lifecycle", lifecycleSpec);
    const models = result.readFile("visibility-api", "models.ts");
    const server = result.readFile("visibility-api", "server.ts");

    for (const property of [
      "id: string;",
      "createOnly: string;",
      "updateOnly: string;",
      "writeOnly: string;",
      "notRead: string;",
      "internal: string;",
    ]) {
      expect(models).toContain(property);
    }

    const resourceAliases = projectedAliases(server, "Resource");
    expect(resourceAliases).toHaveLength(4);

    const createAlias = resourceAliases.find(
      ({ body }) => body.includes("createOnly: string") && !body.includes("updateOnly"),
    );
    expect(createAlias?.body).toContain("writeOnly: string");
    expect(createAlias?.body).toContain("notRead: string");
    expect(createAlias?.body).not.toContain("id:");
    expect(createAlias?.body).not.toContain("internal:");

    const replaceAlias = resourceAliases.find(
      ({ body }) => body.includes("createOnly: string") && body.includes("updateOnly: string"),
    );
    expect(replaceAlias?.body).toContain("writeOnly: string");
    expect(replaceAlias?.body).not.toContain("id:");

    const updateAlias = resourceAliases.find(({ body }) => body.includes("updateOnly?: string"));
    expect(updateAlias?.body).toContain("writeOnly?: string");
    expect(updateAlias?.body).toContain("nested?:");
    expect(updateAlias?.body).toContain("items?:");
    expect(updateAlias?.body).not.toContain("createOnly");

    const readAlias = resourceAliases.find(({ body }) => body.includes("id: string"));
    expect(readAlias?.body).toContain("name: string");
    expect(readAlias?.body).not.toContain("createOnly");
    expect(readAlias?.body).not.toContain("updateOnly");
    expect(readAlias?.body).not.toContain("writeOnly");
    expect(readAlias?.body).not.toContain("notRead");
    expect(readAlias?.body).not.toContain("internal");

    const nestedAliases = projectedAliases(server, "Nested");
    const patchNested = nestedAliases.find(
      ({ body }) =>
        body.includes("updateNested?: string") && body.includes("commonNested?: string"),
    );
    expect(patchNested?.body).toContain("writeNested?: string");
    const patchItem = nestedAliases.find(
      ({ body }) =>
        body.includes("updateNested: string") &&
        body.includes("commonNested: string") &&
        !body.includes("createNested"),
    );
    expect(patchItem?.name).toContain("_item");
    expect(patchItem?.body).toContain("writeNested: string");

    const [cycleLeft] = projectedAliases(server, "CycleLeft");
    const [cycleRight] = projectedAliases(server, "CycleRight");
    expect(cycleLeft?.body).toContain("right: _TypespexPayload_CycleRight_");
    expect(cycleLeft?.body).not.toContain("readOnly");
    expect(cycleRight?.body).toContain("left?: _TypespexPayload_CycleLeft_");

    result.typecheck("visibility-api");

    const { createVisibilityApiServerRouter } = await import(
      `${result.outputDir}/visibility-api/server-router.ts`
    );
    const received = new Map<string, unknown>();
    const router = createVisibilityApiServerRouter({
      create(input: unknown) {
        received.set("create", input);
        return responseResource();
      },
      replace(input: unknown) {
        received.set("replace", input);
        return responseResource();
      },
      update(input: unknown) {
        received.set("update", input);
        return responseResource();
      },
      read(input: unknown) {
        received.set("read", input);
        return responseResource();
      },
      createCycle(input: unknown) {
        received.set("createCycle", input);
      },
    } as any);

    const createBody = {
      createOnly: "create",
      writeOnly: "write",
      notRead: "not-read",
      name: "new",
      nested: {
        createNested: "nested-create",
        writeNested: "nested-write",
        commonNested: "nested-common",
      },
      items: [
        {
          createNested: "item-create",
          writeNested: "item-write",
          commonNested: "item-common",
        },
      ],
    };
    const createResponse = await router.handle(jsonRequest("POST", "/resources", createBody));
    expect(createResponse.status).toBe(200);
    expect(received.get("create")).toEqual(createBody);
    expect(await createResponse.json()).toEqual({
      id: "generated-id",
      name: "visible-name",
      nested: { readNested: "nested-read", commonNested: "nested-common" },
      items: [{ readNested: "item-read", commonNested: "item-common" }],
    });

    const patchBody = { nested: { updateNested: "nested-update" } };
    const patchResponse = await router.handle(jsonRequest("PATCH", "/resources/item-1", patchBody));
    expect(patchResponse.status).toBe(200);
    expect(received.get("update")).toEqual({ id: "item-1", ...patchBody });

    const invalidPatchItem = await router.handle(
      jsonRequest("PATCH", "/resources/item-1", {
        items: [{ updateNested: "item-update", writeNested: "item-write" }],
      }),
    );
    expect(invalidPatchItem.status).toBe(400);

    const validPatchItems = {
      items: [
        {
          updateNested: "item-update",
          writeNested: "item-write",
          commonNested: "item-common",
        },
      ],
    };
    const validPatchResponse = await router.handle(
      jsonRequest("PATCH", "/resources/item-2", validPatchItems),
    );
    expect(validPatchResponse.status).toBe(200);
    expect(received.get("update")).toEqual({ id: "item-2", ...validPatchItems });

    const validCycle = { right: {} };
    const validCycleResponse = await router.handle(jsonRequest("POST", "/cycles", validCycle));
    expect(validCycleResponse.status).toBe(204);
    expect(received.get("createCycle")).toEqual(validCycle);

    const hiddenNestedCycleProperty = await router.handle(
      jsonRequest("POST", "/cycles", {
        right: { left: { right: {}, readOnly: "must-not-be-accepted" } },
      }),
    );
    expect(hiddenNestedCycleProperty.status).toBe(400);
  });

  test("applies operation overrides before metadata placement", async () => {
    const result = compileFixture("visibility-overrides", overrideAndMetadataSpec);
    const server = result.readFile("visibility-override-api", "server.ts");
    const operations = result.readFile("visibility-override-api", "server-operations.ts");

    const overrideAliases = projectedAliases(server, "OverrideResource");
    expect(overrideAliases).toHaveLength(2);
    expect(
      overrideAliases.some(
        ({ body }) => body.includes("readOnly: string") && !body.includes("createOnly"),
      ),
    ).toBe(true);
    expect(
      overrideAliases.some(
        ({ body }) => body.includes("createOnly: string") && !body.includes("readOnly"),
      ),
    ).toBe(true);
    expect(operations).toContain('RequestDecoders.header("x-create-token"');
    expect(operations).toContain('headers: [["readToken", "x-read-token"]]');
    result.typecheck("visibility-override-api");

    const { createVisibilityOverrideApiServerRouter } = await import(
      `${result.outputDir}/visibility-override-api/server-router.ts`
    );
    const received = new Map<string, unknown>();
    const router = createVisibilityOverrideApiServerRouter({
      submitMetadata(input: unknown) {
        received.set("metadata", input);
        return {
          createToken: "must-not-leak",
          readToken: "response-token",
          value: "response-value",
        };
      },
      override(input: unknown) {
        received.set("override", input);
        return {
          readOnly: "must-not-leak",
          createOnly: "response-create",
          common: "response-common",
        };
      },
    } as any);

    const metadataResponse = await router.handle(
      jsonRequest(
        "POST",
        "/metadata",
        { value: "request-value" },
        {
          "x-create-token": "request-token",
        },
      ),
    );
    expect(metadataResponse.status).toBe(200);
    expect(received.get("metadata")).toEqual({
      createToken: "request-token",
      value: "request-value",
    });
    expect(await metadataResponse.json()).toEqual({ value: "response-value" });
    expect(metadataResponse.headers.get("x-read-token")).toBe("response-token");
    expect(metadataResponse.headers.get("x-create-token")).toBeNull();

    const overrideResponse = await router.handle(
      jsonRequest("POST", "/override", { readOnly: "request-read", common: "request-common" }),
    );
    expect(overrideResponse.status).toBe(200);
    expect(received.get("override")).toEqual({
      readOnly: "request-read",
      common: "request-common",
    });
    expect(await overrideResponse.json()).toEqual({
      createOnly: "response-create",
      common: "response-common",
    });

    const forbiddenOverrideProperty = await router.handle(
      jsonRequest("POST", "/override", {
        readOnly: "request-read",
        createOnly: "must-not-be-accepted",
        common: "request-common",
      }),
    );
    expect(forbiddenOverrideProperty.status).toBe(400);
  });

  test("allocates collision-safe aliases deterministically", () => {
    const first = compileFixture("visibility-aliases-first", collidingNamesSpec);
    const second = compileFixture("visibility-aliases-second", collidingNamesSpec);
    const firstServer = first.readFile("visibility-alias-api", "server.ts");
    const secondServer = second.readFile("visibility-alias-api", "server.ts");
    const firstOperations = first.readFile("visibility-alias-api", "server-operations.ts");
    const secondOperations = second.readFile("visibility-alias-api", "server-operations.ts");

    expect(secondServer).toBe(firstServer);
    expect(secondOperations).toBe(firstOperations);

    const aliasNames = [
      ...firstServer.matchAll(/type (_TypespexPayload_(?:Sales|Support)_Item_[A-Za-z0-9_]+) =/g),
    ].map((match) => match[1]!);
    expect(aliasNames).toHaveLength(4);
    expect(new Set(aliasNames).size).toBe(4);
    expect(aliasNames.some((name) => name.includes("Sales_Item"))).toBe(true);
    expect(aliasNames.some((name) => name.includes("Support_Item"))).toBe(true);
    first.typecheck("visibility-alias-api");
  });
});
