import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildEmitter,
  cleanupFixtures,
  compileFixture,
  compileFixtureExpectingDiagnostics,
} from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

describe("typed stream diagnostics", () => {
  test("emits typed JSONL request handlers and item decoders", async () => {
    const result = compileFixture(
      "typed-jsonl-request",
      `
        import "@typespec/http/streams";

        using TypeSpec.Http;
        using TypeSpec.Http.Streams;

        @service namespace TypedJsonlRequestApi {
          model Info {
            @encodedName("application/json", "description")
            @minLength(2)
            desc: string;
            count: int64;
          }

          @route("/send")
          @post op send(stream: JsonlStream<Info>): void;
        }
      `,
    );
    const server = result.readFile("typed-jsonl-request-api", "server.ts");
    const operations = result.readFile("typed-jsonl-request-api", "server-operations.ts");

    expect(server).toContain("OperationHandler<AsyncIterable<Info>, void");
    expect(server).not.toContain("contentType");
    expect(operations).toContain("decodeJsonlBody<Info>(request");
    expect(operations).toContain('wireNames: { desc: "description" }');
    expect(operations).toContain("Validators.minLength(2)");
    result.typecheck("typed-jsonl-request-api");

    const { createTypedJsonlRequestApiServerRouter } = await import(
      `${result.outputDir}/typed-jsonl-request-api/server-router.ts`
    );
    const received: Array<{ desc: string; count: bigint }> = [];
    const router = createTypedJsonlRequestApiServerRouter({
      async send(items) {
        for await (const item of items) received.push(item);
      },
    });

    const response = await router.handle(
      new Request("http://localhost/send", {
        method: "POST",
        headers: { "content-type": "application/jsonl; charset=utf-8" },
        body:
          '{"description":"first","count":9223372036854775807}\n' +
          '{"description":"second","count":2}\n',
      }),
    );
    expect(response.status).toBe(204);
    expect(received).toEqual([
      { desc: "first", count: 9_223_372_036_854_775_807n },
      { desc: "second", count: 2n },
    ]);

    const invalid = await router.handle(
      new Request("http://localhost/send", {
        method: "POST",
        headers: { "content-type": "application/jsonl" },
        body: '{"description":"x","count":1}\n',
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      issues: [{ path: "$body[0].description" }],
    });
  });

  test("honors optional JSONL Content-Type metadata", async () => {
    const result = compileFixture(
      "typed-jsonl-optional-content-type",
      `
        import "@typespec/http";
        import "@typespec/streams";

        using TypeSpec.Http;
        using TypeSpec.Streams;

        @service namespace TypedJsonlOptionalContentTypeApi {
          model Info {
            desc: string;
          }

          @streamOf(Info)
          model JsonlStream {
            @header contentType?: "application/jsonl";
            @body body: string;
          }

          @route("/send")
          @post op send(stream: JsonlStream): void;
        }
      `,
    );
    const server = result.readFile("typed-jsonl-optional-content-type-api", "server.ts");
    const operations = result.readFile(
      "typed-jsonl-optional-content-type-api",
      "server-operations.ts",
    );

    expect(server).toContain("OperationHandler<AsyncIterable<Info>, void");
    expect(operations).toContain("allowMissingContentType: true");
    result.typecheck("typed-jsonl-optional-content-type-api");

    const { createTypedJsonlOptionalContentTypeApiServerRouter } = await import(
      `${result.outputDir}/typed-jsonl-optional-content-type-api/server-router.ts`
    );
    const received: string[] = [];
    const router = createTypedJsonlOptionalContentTypeApiServerRouter({
      async send(items) {
        for await (const item of items) received.push(item.desc);
      },
    });
    const request = new Request("http://localhost/send", {
      method: "POST",
      body: new TextEncoder().encode('{"desc":"accepted"}\n'),
    });
    expect(request.headers.get("content-type")).toBeNull();

    const response = await router.handle(request);
    expect(response.status).toBe(204);
    expect(received).toEqual(["accepted"]);
  });

  test("combines request metadata with a lazy JSONL body", async () => {
    const result = compileFixture(
      "typed-jsonl-request-metadata",
      `
        import "@typespec/http/streams";

        using TypeSpec.Http;
        using TypeSpec.Http.Streams;

        @service namespace TypedJsonlRequestMetadataApi {
          model Info {
            desc: string;
          }

          @route("/send/{id}")
          @post op send(@path id: int32, stream: JsonlStream<Info>): void;
        }
      `,
    );
    const server = result.readFile("typed-jsonl-request-metadata-api", "server.ts");
    const operations = result.readFile("typed-jsonl-request-metadata-api", "server-operations.ts");

    expect(server).toContain("{ id: number; body: AsyncIterable<Info> }");
    expect(server).not.toContain("contentType");
    expect(operations).toContain('decodeRequestInputAndJsonlBody<{ id: number }, Info, "body">');
    result.typecheck("typed-jsonl-request-metadata-api");

    const { createTypedJsonlRequestMetadataApiServerRouter } = await import(
      `${result.outputDir}/typed-jsonl-request-metadata-api/server-router.ts`
    );
    const received: Array<{ id: number; desc: string }> = [];
    const router = createTypedJsonlRequestMetadataApiServerRouter({
      async send({ id, body }) {
        for await (const item of body) received.push({ id, desc: item.desc });
      },
    });

    const response = await router.handle(
      new Request("http://localhost/send/42", {
        method: "POST",
        headers: { "content-type": "application/jsonl" },
        body: '{"desc":"accepted"}\n',
      }),
    );
    expect(response.status).toBe(204);
    expect(received).toEqual([{ id: 42, desc: "accepted" }]);

    const invalid = await router.handle(
      new Request("http://localhost/send/not-an-integer", {
        method: "POST",
        headers: { "content-type": "application/jsonl" },
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: "Invalid request",
      issues: [
        { path: "$path.id", message: "Expected a finite number." },
        { path: "$body", message: "Required body is missing." },
      ],
    });
  });

  test("projects JSONL items with request visibility", () => {
    const result = compileFixture(
      "typed-jsonl-request-visibility",
      `
        import "@typespec/http/streams";

        using TypeSpec.Http;
        using TypeSpec.Http.Streams;

        @service namespace TypedJsonlRequestVisibilityApi {
          model Info {
            @visibility(Lifecycle.Read) id: string;
            @visibility(Lifecycle.Create) secret: string;
            common: string;
          }

          @route("/send")
          @post op send(stream: JsonlStream<Info>): void;
        }
      `,
    );
    const server = result.readFile("typed-jsonl-request-visibility-api", "server.ts");
    const operations = result.readFile(
      "typed-jsonl-request-visibility-api",
      "server-operations.ts",
    );

    expect(server).toContain("secret: string; common: string");
    expect(server).not.toContain("AsyncIterable<Info>");
    expect(operations).toContain('forbiddenProperties: ["id"]');
    result.typecheck("typed-jsonl-request-visibility-api");
  });

  test("rejects optional JSONL request bodies", () => {
    const result = compileFixtureExpectingDiagnostics(
      "typed-jsonl-optional-request",
      `
        import "@typespec/http/streams";

        using TypeSpec.Http;
        using TypeSpec.Http.Streams;

        @service namespace TypedJsonlOptionalRequestApi {
          model Info {
            desc: string;
          }

          @route("/send")
          @post op send(stream?: JsonlStream<Info>): void;
        }
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("unsupported-request-body");
    expect(diagnostics).toContain("JSONL request streams require a body");
    expect(result.listFiles("typed-jsonl-optional-request-api")).toEqual([]);
  });

  test("rejects JSONL request streams in same-endpoint overloads", () => {
    const result = compileFixtureExpectingDiagnostics(
      "typed-jsonl-request-overload",
      `
        import "@typespec/http/streams";

        using TypeSpec.Http;
        using TypeSpec.Http.Streams;

        @service namespace TypedJsonlRequestOverloadApi {
          model Info {
            desc: string;
          }

          @route("/send")
          @post op send(stream: JsonlStream<Info>): void;

          @overload(send)
          op sendAgain(stream: JsonlStream<Info>): void;
        }
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("unsupported-request-body");
    expect(diagnostics).toContain(
      "typed request streams cannot participate in same-endpoint overloads",
    );
    expect(result.listFiles("typed-jsonl-request-overload-api")).toEqual([]);
  });

  test("rejects request stream protocols without a dedicated decoder", () => {
    const result = compileFixtureExpectingDiagnostics(
      "typed-request-stream",
      `
        import "@typespec/http";
        import "@typespec/streams";

        using TypeSpec.Http;
        using TypeSpec.Streams;

        @service namespace TypedRequestStreamApi {
          model Info {
            desc: string;
          }

          @streamOf(Info)
          model EventStream {
            @header contentType: "text/event-stream";
            @body body: string;
          }

          @route("/send")
          @post op send(stream: EventStream): void;
        }
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("unsupported-request-body");
    expect(diagnostics).toContain(
      "typed streams require a dedicated streaming decoder for this content type",
    );
    expect(result.listFiles("typed-request-stream-api")).toEqual([]);
  });

  test("emits typed JSONL response handlers and item serializers", async () => {
    const result = compileFixture(
      "typed-jsonl-response",
      `
        import "@typespec/http/streams";

        using TypeSpec.Http;
        using TypeSpec.Http.Streams;

        @service namespace TypedJsonlResponseApi {
          model Info {
            @encodedName("application/json", "description")
            desc: string;
            count: int64;
          }

          @route("/receive")
          @get op receive(): JsonlStream<Info>;
        }
      `,
    );
    const server = result.readFile("typed-jsonl-response-api", "server.ts");
    const operations = result.readFile("typed-jsonl-response-api", "server-operations.ts");

    expect(server).toContain("AsyncIterable<Info>");
    expect(operations).toContain("ResponseEncoders.jsonl<Info>(200, (value) =>");
    expect(operations).toContain('property: "desc", wireName: "description"');
    result.typecheck("typed-jsonl-response-api");

    const { createTypedJsonlResponseApiServerRouter } = await import(
      `${result.outputDir}/typed-jsonl-response-api/server-router.ts`
    );
    const router = createTypedJsonlResponseApiServerRouter({
      async *receive() {
        yield { desc: "first", count: 9_223_372_036_854_775_807n };
        yield { desc: "second", count: 2n };
      },
    });

    const response = await router.handle(new Request("http://localhost/receive"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/jsonl");
    expect(await response.text()).toBe(
      '{"description":"first","count":9223372036854775807}\n' +
        '{"description":"second","count":2}\n',
    );
  });

  test("rejects typed response protocols without a dedicated encoder", () => {
    const result = compileFixtureExpectingDiagnostics(
      "typed-response-stream",
      `
        import "@typespec/http";
        import "@typespec/streams";

        using TypeSpec.Http;
        using TypeSpec.Streams;

        @service namespace TypedResponseStreamApi {
          model Info {
            desc: string;
          }

          @streamOf(Info)
          model EventStream {
            @header contentType: "application/x-custom-stream";
            @body body: string;
          }

          @route("/receive")
          @get op receive(): EventStream;
        }
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("unsupported-response-body");
    expect(diagnostics).toContain("typed streams require a dedicated streaming encoder");
    expect(result.listFiles("typed-response-stream-api")).toEqual([]);
  });

  test("rejects JSONL streams combined with other response variants", () => {
    const result = compileFixtureExpectingDiagnostics(
      "typed-response-stream-union",
      `
        import "@typespec/http/streams";

        using TypeSpec.Http;
        using TypeSpec.Http.Streams;

        @service namespace TypedResponseStreamUnionApi {
          model Info {
            desc: string;
          }

          @error model Failure {
            @statusCode status: 500;
            message: string;
          }

          @route("/receive")
          @get op receive(): JsonlStream<Info> | Failure;
        }
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("unsupported-response-body");
    expect(diagnostics).toContain(
      "typed stream responses cannot be combined with other response variants",
    );
    expect(result.listFiles("typed-response-stream-union-api")).toEqual([]);
  });
});
