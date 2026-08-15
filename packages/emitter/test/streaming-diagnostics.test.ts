import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildEmitter,
  cleanupFixtures,
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

  test("rejects response streams before emitting string-based bindings", () => {
    const result = compileFixtureExpectingDiagnostics(
      "typed-response-stream",
      `
        import "@typespec/http/streams";

        using TypeSpec.Http;
        using TypeSpec.Http.Streams;

        @service namespace TypedResponseStreamApi {
          model Info {
            desc: string;
          }

          @route("/receive")
          @get op receive(): JsonlStream<Info>;
        }
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("unsupported-response-body");
    expect(diagnostics).toContain("typed streams require a dedicated streaming encoder");
    expect(result.listFiles("typed-response-stream-api")).toEqual([]);
  });
});
