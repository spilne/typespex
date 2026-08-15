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
  test("rejects request streams before emitting string-based bindings", () => {
    const result = compileFixtureExpectingDiagnostics(
      "typed-request-stream",
      `
        import "@typespec/http/streams";

        using TypeSpec.Http;
        using TypeSpec.Http.Streams;

        @service namespace TypedRequestStreamApi {
          model Info {
            desc: string;
          }

          @route("/send")
          @post op send(stream: JsonlStream<Info>): void;
        }
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("unsupported-request-body");
    expect(diagnostics).toContain("typed streams require a dedicated streaming decoder");
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
            @header contentType: "text/event-stream";
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
