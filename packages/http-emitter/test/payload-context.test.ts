import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildEmitter, cleanupFixtures, compileFixture } from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const payloadContextSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "PayloadContextApi" })
namespace PayloadContextApi;

model ExplicitPayload {
  value: string;
  @header("x-body-trace") trace: string;
}

model IgnoredMetadata {
  @header("x-token") token: string;
  dropped: string;
}

model RootPayload {
  value: string;
  nested: {
    label: string;
    @header("x-nested-trace") trace: string;
  };
  @bodyIgnore ignored: IgnoredMetadata;
}

model ExplicitResponse {
  @body payload: ExplicitPayload;
}

model RootResponse {
  @bodyRoot payload: RootPayload;
}

model ReusedRootResponse {
  @bodyRoot payload: ExplicitPayload;
}

model IgnoredResponse {
  name: string;
  @bodyIgnore metadata: IgnoredMetadata;
}

@route("/request/explicit")
@post
op requestExplicit(@body payload: ExplicitPayload): void;

@route("/request/explicit-anonymous")
@post
op requestExplicitAnonymous(@body payload: {
  value: string;
  @header("x-anonymous-body-trace") trace: string;
}): void;

@route("/request/root-reuse")
@post
op requestRootReuse(@bodyRoot payload: ExplicitPayload): void;

@route("/request/root")
@post
op requestRoot(@bodyRoot payload: RootPayload): void;

@route("/request/root-anonymous")
@post
op requestRootAnonymous(@bodyRoot payload: {
  value: string;
  nested: {
    label: string;
    @header("x-anonymous-root-trace") trace: string;
  };
}): void;

@route("/request/ignored")
@post
op requestIgnored(name: string, @bodyIgnore metadata: IgnoredMetadata): void;

@route("/request/ignored-anonymous")
@post
op requestIgnoredAnonymous(
  name: string,
  @bodyIgnore metadata: {
    @header("x-anonymous-token") token: string;
    dropped: string;
  },
): void;

@route("/response/explicit")
@get
op responseExplicit(): ExplicitResponse;

@route("/response/explicit-anonymous")
@get
op responseExplicitAnonymous(): {
  @body payload: {
    value: string;
    @header("x-anonymous-body-trace") trace: string;
  };
};

@route("/response/root-reuse")
@get
op responseRootReuse(): ReusedRootResponse;

@route("/response/root")
@get
op responseRoot(): RootResponse;

@route("/response/root-anonymous")
@get
op responseRootAnonymous(): {
  @bodyRoot payload: {
    value: string;
    nested: {
      label: string;
      @header("x-anonymous-root-trace") trace: string;
    };
  };
};

@route("/response/ignored")
@get
op responseIgnored(): IgnoredResponse;

@route("/response/ignored-anonymous")
@get
op responseIgnoredAnonymous(): {
  name: string;
  @bodyIgnore metadata: {
    @header("x-anonymous-token") token: string;
    dropped: string;
  };
};
`;

const recursiveProjectionSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "RecursiveProjectionApi" })
namespace RecursiveProjectionApi;

model RecursiveNode {
  value: string;
  @header("x-node-trace") trace: string;
  child?: RecursiveNode;
}

model RecursiveResponse {
  @bodyRoot payload: RecursiveNode;
}

@route("/nodes")
@post
op create(@bodyRoot payload: RecursiveNode): void;

@route("/nodes")
@get
op read(): RecursiveResponse;
`;

const mixedItemProjectionSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "MixedItemProjectionApi" })
namespace MixedItemProjectionApi;

model Shared {
  @header("x-direct-trace") trace: string;
  value: string;
}

model MixedRoot {
  items: Shared[];
  direct: Shared;
}

model MetadataOnly {
  @header("x-only-trace") trace: string;
}

@route("/mixed")
@post
op mixed(@bodyRoot payload: MixedRoot): void;

@route("/empty")
@post
op empty(@bodyRoot payload: MetadataOnly): void;
`;

function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("HTTP payload body context", () => {
  test("keeps canonical models complete while projecting request and response wire shapes", async () => {
    const result = compileFixture("payload-context", payloadContextSpec);
    const models = result.readFile("payload-context-api", "models.ts");
    const server = result.readFile("payload-context-api", "server.ts");
    const operations = result.readFile("payload-context-api", "server-operations.ts");

    expect(models).toContain("export interface ExplicitPayload");
    expect(models).toContain("trace: string;");
    expect(models).toContain("export interface IgnoredMetadata");
    expect(models).toContain("dropped: string;");
    expect(server).toContain(
      "readonly requestExplicit: OperationHandler<ExplicitPayload, void, Ctx>",
    );
    expect(server).toContain("readonly responseExplicit: OperationHandler<");
    expect(server).toContain("{ payload: ExplicitPayload }");
    expect(operations).toContain('["trace", "x-nested-trace"]');
    expect(operations).toContain('["token", "x-token"]');
    result.typecheck("payload-context-api");

    const { createPayloadContextApiServerRouter } = await import(
      `${result.outputDir}/payload-context-api/server-router.ts`
    );
    const received = new Map<string, unknown>();
    const router = createPayloadContextApiServerRouter({
      requestExplicit(input: unknown) {
        received.set("requestExplicit", input);
      },
      requestExplicitAnonymous(input: unknown) {
        received.set("requestExplicitAnonymous", input);
      },
      requestRootReuse(input: unknown) {
        received.set("requestRootReuse", input);
      },
      requestRoot(input: unknown) {
        received.set("requestRoot", input);
      },
      requestRootAnonymous(input: unknown) {
        received.set("requestRootAnonymous", input);
      },
      requestIgnored(input: unknown) {
        received.set("requestIgnored", input);
      },
      requestIgnoredAnonymous(input: unknown) {
        received.set("requestIgnoredAnonymous", input);
      },
      responseExplicit() {
        return { payload: { value: "explicit", trace: "json-trace" } };
      },
      responseExplicitAnonymous() {
        return { payload: { value: "anonymous", trace: "anonymous-json-trace" } };
      },
      responseRootReuse() {
        return { value: "reused-root", trace: "reused-root-header" };
      },
      responseRoot() {
        return {
          value: "root",
          nested: { label: "nested" },
          trace: "header-trace",
          token: "header-token",
        };
      },
      responseRootAnonymous() {
        return {
          value: "anonymous-root",
          nested: { label: "anonymous-nested" },
          trace: "anonymous-header-trace",
        };
      },
      responseIgnored() {
        return { name: "kept", token: "ignored-header-token" };
      },
      responseIgnoredAnonymous() {
        return { name: "anonymous-kept", token: "anonymous-ignored-header-token" };
      },
    } as any);

    expect(
      (
        await router.handle(
          jsonRequest("/request/explicit", {
            value: "explicit",
            trace: "json-trace",
          }),
        )
      ).status,
    ).toBe(204);
    expect(received.get("requestExplicit")).toEqual({
      value: "explicit",
      trace: "json-trace",
    });

    expect(
      (
        await router.handle(
          jsonRequest("/request/explicit-anonymous", {
            value: "anonymous",
            trace: "anonymous-json-trace",
          }),
        )
      ).status,
    ).toBe(204);
    expect(received.get("requestExplicitAnonymous")).toEqual({
      value: "anonymous",
      trace: "anonymous-json-trace",
    });

    expect(
      (
        await router.handle(
          jsonRequest(
            "/request/root-reuse",
            { value: "reused-root" },
            { "x-body-trace": "reused-root-header" },
          ),
        )
      ).status,
    ).toBe(204);
    expect(received.get("requestRootReuse")).toEqual({
      trace: "reused-root-header",
      value: "reused-root",
    });

    expect(
      (
        await router.handle(
          jsonRequest(
            "/request/root",
            { value: "root", nested: { label: "nested" } },
            { "x-nested-trace": "header-trace", "x-token": "header-token" },
          ),
        )
      ).status,
    ).toBe(204);
    expect(received.get("requestRoot")).toEqual({
      trace: "header-trace",
      token: "header-token",
      value: "root",
      nested: { label: "nested" },
    });

    expect(
      (
        await router.handle(
          jsonRequest(
            "/request/root-anonymous",
            { value: "anonymous-root", nested: { label: "anonymous-nested" } },
            { "x-anonymous-root-trace": "anonymous-header-trace" },
          ),
        )
      ).status,
    ).toBe(204);
    expect(received.get("requestRootAnonymous")).toEqual({
      trace: "anonymous-header-trace",
      value: "anonymous-root",
      nested: { label: "anonymous-nested" },
    });

    expect(
      (
        await router.handle(
          jsonRequest("/request/ignored", { name: "kept" }, { "x-token": "header-token" }),
        )
      ).status,
    ).toBe(204);
    expect(received.get("requestIgnored")).toEqual({
      token: "header-token",
      name: "kept",
    });

    expect(
      (
        await router.handle(
          jsonRequest(
            "/request/ignored-anonymous",
            { name: "anonymous-kept" },
            { "x-anonymous-token": "anonymous-header-token" },
          ),
        )
      ).status,
    ).toBe(204);
    expect(received.get("requestIgnoredAnonymous")).toEqual({
      token: "anonymous-header-token",
      name: "anonymous-kept",
    });

    const duplicateRootMetadata = await router.handle(
      jsonRequest(
        "/request/root",
        {
          value: "root",
          nested: { label: "nested", trace: "must-not-come-from-json" },
        },
        { "x-nested-trace": "header-trace", "x-token": "header-token" },
      ),
    );
    expect(duplicateRootMetadata.status).toBe(400);

    const ignoredBodyValue = await router.handle(
      jsonRequest(
        "/request/root",
        {
          value: "root",
          nested: { label: "nested" },
          ignored: { token: "json-token", dropped: "must-not-be-json" },
        },
        { "x-nested-trace": "header-trace", "x-token": "header-token" },
      ),
    );
    expect(ignoredBodyValue.status).toBe(400);

    const explicitResponse = await router.handle(new Request("http://localhost/response/explicit"));
    expect(await explicitResponse.json()).toEqual({
      value: "explicit",
      trace: "json-trace",
    });
    expect(explicitResponse.headers.get("x-body-trace")).toBeNull();

    const anonymousExplicitResponse = await router.handle(
      new Request("http://localhost/response/explicit-anonymous"),
    );
    expect(await anonymousExplicitResponse.json()).toEqual({
      value: "anonymous",
      trace: "anonymous-json-trace",
    });
    expect(anonymousExplicitResponse.headers.get("x-anonymous-body-trace")).toBeNull();

    const reusedRootResponse = await router.handle(
      new Request("http://localhost/response/root-reuse"),
    );
    expect(await reusedRootResponse.json()).toEqual({ value: "reused-root" });
    expect(reusedRootResponse.headers.get("x-body-trace")).toBe("reused-root-header");

    const rootResponse = await router.handle(new Request("http://localhost/response/root"));
    expect(await rootResponse.json()).toEqual({
      value: "root",
      nested: { label: "nested" },
    });
    expect(rootResponse.headers.get("x-nested-trace")).toBe("header-trace");
    expect(rootResponse.headers.get("x-token")).toBe("header-token");

    const anonymousRootResponse = await router.handle(
      new Request("http://localhost/response/root-anonymous"),
    );
    expect(await anonymousRootResponse.json()).toEqual({
      value: "anonymous-root",
      nested: { label: "anonymous-nested" },
    });
    expect(anonymousRootResponse.headers.get("x-anonymous-root-trace")).toBe(
      "anonymous-header-trace",
    );

    const ignoredResponse = await router.handle(new Request("http://localhost/response/ignored"));
    expect(await ignoredResponse.json()).toEqual({ name: "kept" });
    expect(ignoredResponse.headers.get("x-token")).toBe("ignored-header-token");

    const anonymousIgnoredResponse = await router.handle(
      new Request("http://localhost/response/ignored-anonymous"),
    );
    expect(await anonymousIgnoredResponse.json()).toEqual({
      name: "anonymous-kept",
    });
    expect(anonymousIgnoredResponse.headers.get("x-anonymous-token")).toBe(
      "anonymous-ignored-header-token",
    );
  });

  test("emits finite aliases and decoders for recursive projected payloads", async () => {
    const result = compileFixture("recursive-payload-projection", recursiveProjectionSpec);
    const operations = result.readFile("recursive-projection-api", "server-operations.ts");

    expect(operations).toMatch(
      /type (_TypespexPayload_RecursiveNode_request_[A-Za-z0-9_]+) = \{\s*value: string;\s*child\?: \1;\s*\};/,
    );
    expect(operations).toContain("Decoders.lazy");
    result.typecheck("recursive-projection-api");

    const { createRecursiveProjectionApiServerRouter } = await import(
      `${result.outputDir}/recursive-projection-api/server-router.ts`
    );
    let received: unknown;
    const router = createRecursiveProjectionApiServerRouter({
      create(input: unknown) {
        received = input;
      },
      read() {
        return {
          value: "root",
          child: { value: "leaf" },
          trace: "response-trace",
        };
      },
    } as any);

    const createResponse = await router.handle(
      jsonRequest(
        "/nodes",
        { value: "root", child: { value: "leaf" } },
        { "x-node-trace": "request-trace" },
      ),
    );
    expect(createResponse.status).toBe(204);
    expect(received).toEqual({
      trace: "request-trace",
      value: "root",
      child: { value: "leaf" },
    });

    const readResponse = await router.handle(new Request("http://localhost/nodes"));
    expect(await readResponse.json()).toEqual({
      value: "root",
      child: { value: "leaf" },
    });
    expect(readResponse.headers.get("x-node-trace")).toBe("response-trace");
  });

  test("keeps metadata in collection items while projecting direct uses", async () => {
    const result = compileFixture("mixed-item-projection", mixedItemProjectionSpec);
    const operations = result.readFile("mixed-item-projection-api", "server-operations.ts");

    expect(operations).toContain("items: Shared[]");
    expect(operations).toMatch(/direct: _TypespexPayload_Shared_request_[A-Za-z0-9_]+/);
    expect(operations).toMatch(
      /type _TypespexPayload_MetadataOnly_request_[A-Za-z0-9_]+ = Record<string, never>;/,
    );
    result.typecheck("mixed-item-projection-api");

    const { createMixedItemProjectionApiServerRouter } = await import(
      `${result.outputDir}/mixed-item-projection-api/server-router.ts`
    );
    const received = new Map<string, unknown>();
    const router = createMixedItemProjectionApiServerRouter({
      mixed(input: unknown) {
        received.set("mixed", input);
      },
      empty(input: unknown) {
        received.set("empty", input);
      },
    } as any);

    const mixedResponse = await router.handle(
      jsonRequest(
        "/mixed",
        {
          items: [{ trace: "item-json-trace", value: "item" }],
          direct: { value: "direct" },
        },
        { "x-direct-trace": "direct-header-trace" },
      ),
    );
    expect(mixedResponse.status).toBe(204);
    expect(received.get("mixed")).toEqual({
      trace: "direct-header-trace",
      items: [{ trace: "item-json-trace", value: "item" }],
      direct: { value: "direct" },
    });

    const directMetadataInJson = await router.handle(
      jsonRequest(
        "/mixed",
        {
          items: [{ trace: "item-json-trace", value: "item" }],
          direct: { trace: "must-not-be-json", value: "direct" },
        },
        { "x-direct-trace": "direct-header-trace" },
      ),
    );
    expect(directMetadataInJson.status).toBe(400);

    const emptyResponse = await router.handle(
      jsonRequest("/empty", {}, { "x-only-trace": "only-header-trace" }),
    );
    expect(emptyResponse.status).toBe(204);
    expect(received.get("empty")).toEqual({ trace: "only-header-trace" });
  });
});
