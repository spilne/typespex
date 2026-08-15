import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildEmitter,
  cleanupFixtures,
  compileFixture,
  compileFixtureExpectingDiagnostics,
} from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const imports = `
  import "@typespec/http";
  import "@typespec/events";
  import "@typespec/sse";

  using TypeSpec.Http;
  using TypeSpec.Events;
  using TypeSpec.SSE;
`;

describe("SSE responses", () => {
  test("emits official unnamed, named, terminal, and POST-response stream shapes", async () => {
    const result = compileFixture(
      "sse-response",
      `
        ${imports}

        @service
        @route("/streaming/sse")
        namespace SseResponseApi {
          model Info {
            @encodedName("application/json", "description")
            desc: string;
            count: int64;
          }

          @events
          union UnnamedEvents {
            @contentType("application/json")
            Info,
          }

          @route("/unnamed")
          @get op unnamed(): SSEStream<UnnamedEvents>;

          model ResponseCreated { id: string; }
          model ResponseDelta { delta: string; }

          @events
          union ResponseEvents {
            @contentType("application/json")
            responseCreated: ResponseCreated,

            @contentType("application/json")
            responseDelta: ResponseDelta,

            @contentType("text/plain")
            @terminalEvent
            "[DONE]",
          }

          @route("/named")
          @get op named(): SSEStream<ResponseEvents>;

          model RetrievalRequest { query: string; }
          model PartialResult { text: string; }
          model FinalResult { references: string[]; }

          @events
          union RetrievalEvents {
            @contentType("application/json")
            partialResult: PartialResult,

            @contentType("application/json")
            finalResult: FinalResult,

            @contentType("text/plain")
            @terminalEvent
            "[DONE]",
          }

          @route("/retrieve")
          @post op retrieve(@body request: RetrievalRequest): SSEStream<RetrievalEvents>;
        }
      `,
    );
    const server = result.readFile("sse-response-api", "server.ts");
    const operations = result.readFile("sse-response-api", "server-operations.ts");

    expect(server).toContain("AsyncIterable<UnnamedEvents>");
    expect(server).toContain("AsyncIterable<ResponseEvents>");
    expect(server).toContain("AsyncIterable<RetrievalEvents>");
    expect(operations).toContain("ResponseEncoders.sse<UnnamedEvents>(200");
    expect(operations).toContain('event: "responseCreated"');
    expect(operations).toContain('event: "responseDelta"');
    expect(operations).toContain("terminal: true");
    expect(operations).toContain("stringifyJson(");
    expect(operations).toContain('property: "desc", wireName: "description"');
    result.typecheck("sse-response-api");

    const { createSseResponseApiServerRouter } = await import(
      `${result.outputDir}/sse-response-api/server-router.ts`
    );
    let query: string | undefined;
    const router = createSseResponseApiServerRouter({
      async *unnamed() {
        yield { desc: "one", count: 9_223_372_036_854_775_807n };
        yield { desc: "two", count: 2n };
      },
      async *named() {
        yield { id: "resp_1" };
        yield { delta: "Hello" };
        yield { delta: " world" };
        yield "[DONE]" as const;
        yield { delta: "unreachable" };
      },
      async *retrieve(input: { query: string }) {
        query = input.query;
        yield { text: "partial one" };
        yield { references: ["doc1", "doc2"] };
        yield "[DONE]" as const;
      },
    });

    const unnamed = await router.handle(new Request("http://localhost/streaming/sse/unnamed"));
    expect(unnamed.status).toBe(200);
    expect(unnamed.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(await unnamed.text()).toBe(
      'data: {"description":"one","count":9223372036854775807}\n\n' +
        'data: {"description":"two","count":2}\n\n',
    );

    const named = await router.handle(new Request("http://localhost/streaming/sse/named"));
    expect(await named.text()).toBe(
      'event: responseCreated\ndata: {"id":"resp_1"}\n\n' +
        'event: responseDelta\ndata: {"delta":"Hello"}\n\n' +
        'event: responseDelta\ndata: {"delta":" world"}\n\n' +
        "data: [DONE]\n\n",
    );

    const retrieve = await router.handle(
      new Request("http://localhost/streaming/sse/retrieve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "what is typespec?" }),
      }),
    );
    const retrieveBody = await retrieve.text();
    expect(query).toBe("what is typespec?");
    expect(retrieveBody).toBe(
      'event: partialResult\ndata: {"text":"partial one"}\n\n' +
        'event: finalResult\ndata: {"references":["doc1","doc2"]}\n\n' +
        "data: [DONE]\n\n",
    );
  });

  test("serializes only the @data field from an event envelope", async () => {
    const result = compileFixture(
      "sse-event-envelope",
      `
        ${imports}

        @service namespace SseEventEnvelopeApi {
          model Payload {
            @encodedName("application/json", "wire_value")
            value: string;
          }

          @events
          union EnvelopeEvents {
            @contentType("application/json")
            update: {
              sequence: int32,
              @data @contentType("application/json") payload: Payload,
            },
          }

          @route("/events")
          @get op events(): SSEStream<EnvelopeEvents>;
        }
      `,
    );
    result.typecheck("sse-event-envelope-api");

    const { createSseEventEnvelopeApiServerRouter } = await import(
      `${result.outputDir}/sse-event-envelope-api/server-router.ts`
    );
    const router = createSseEventEnvelopeApiServerRouter({
      async *events() {
        yield { sequence: 1, payload: { value: "accepted" } };
      },
    });

    const response = await router.handle(new Request("http://localhost/events"));
    expect(await response.text()).toBe('event: update\ndata: {"wire_value":"accepted"}\n\n');
  });

  test("rejects event variants whose handler values overlap", () => {
    const result = compileFixtureExpectingDiagnostics(
      "ambiguous-sse-events",
      `
        ${imports}

        @service namespace AmbiguousSseEventsApi {
          @events
          union Events {
            @contentType("text/plain") first: string,
            @contentType("text/plain") second: string,
          }

          @route("/events")
          @get op events(): SSEStream<Events>;
        }
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("unsupported-response-body");
    expect(diagnostics).toContain("overlap at runtime");
    expect(result.listFiles("ambiguous-sse-events-api")).toEqual([]);
  });

  test("rejects unsupported or missing event payload content types", () => {
    for (const [name, decorator] of [
      ["missing", ""],
      ["binary", '@contentType("application/octet-stream")'],
    ] as const) {
      const result = compileFixtureExpectingDiagnostics(
        `unsupported-sse-${name}`,
        `
          ${imports}

          @service namespace UnsupportedSsePayloadApi {
            @events
            union Events {
              ${decorator} message: string,
            }

            @route("/events")
            @get op events(): SSEStream<Events>;
          }
        `,
      );
      const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

      expect(diagnostics).toContain("unsupported-response-body");
      expect(diagnostics).toContain(
        name === "missing" ? "requires a concrete payload content type" : "unsupported payload",
      );
      expect(result.listFiles("unsupported-sse-payload-api")).toEqual([]);
    }
  });
});
