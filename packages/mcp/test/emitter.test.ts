import { afterAll, describe, expect, test } from "bun:test";
import {
  cleanupFixtures,
  compileFixture,
  compileFixtureWithDiagnostics,
} from "./compile-fixture.js";

afterAll(cleanupFixtures);

describe("@typespex/mcp emitter", () => {
  test("emits only explicit tools with semantic schemas and launchers", () => {
    const result = compileFixture(
      "native",
      `
        import "@typespex/mcp";
        using TypeSpex.Mcp;

        @mcpServer(#{ version: "1.0.0", instructions: "Manage pets" })
        namespace Pets {
          #deprecated "Use CurrentPet."
          @doc("A pet record.")
          model Pet { id: string; createdAt: utcDateTime; }
          @error model Missing { code: "missing"; message: string; }

          @tool(#{ title: "Get pet", annotations: #{ readOnlyHint: true } })
          op getPet(id: string): Pet | Missing;

          @tool op ping(): void;
          op hidden(): string;
        }
      `,
      `    application-module: "./application.js"\n`,
    );
    expect(result.files("pets")).toEqual([
      "mcp-bun.ts",
      "mcp-express.ts",
      "mcp-hono.ts",
      "mcp-node.ts",
      "mcp-operations.ts",
      "mcp-server.ts",
      "mcp-stdio.ts",
      "models.ts",
    ]);
    const operations = result.read("pets", "mcp-operations.ts");
    expect(operations).toContain('name: "getPet"');
    expect(operations).toContain('name: "ping"');
    expect(operations).not.toContain("hidden");
    expect(operations).toContain("errors: getPetErrors");
    expect(operations).toContain("voidResult: true");
    expect(operations).toContain('format: "date-time"');
    expect(operations).toContain('description: "A pet record."');
    expect(operations).toContain("deprecated: true");
    expect(result.read("pets", "models.ts")).toContain("@deprecated Use CurrentPet.");
    const server = result.read("pets", "mcp-server.ts");
    expect(server).toContain('instructions: "Manage pets"');
    expect(server).toContain("export type PingInput = Record<string, never>");
  });

  test("emits a complete HTTP bridge descriptor with inferred annotations", () => {
    const result = compileFixture(
      "bridge",
      `
        import "@typespec/http";
        import "@typespex/mcp";
        using TypeSpec.Http;
        using TypeSpex.Mcp;

        model Pet { id: string; name: string; }
        @error model Missing {
          @statusCode status: 404;
          @body body: { code: "missing"; message: string; };
        }

        @service(#{ title: "Pet API" })
        @server("https://api.example.test")
        @mcpServer(#{ version: "1.0.0" })
        namespace PetApi {
          @tool @get @route("/pets/{id}")
          op getPet(@path id: string, @query verbose?: boolean): Pet | Missing;

          @tool(#{ annotations: #{ destructiveHint: false } })
          @post @route("/pets")
          op createPet(@body pet: Pet): Pet;
        }
      `,
      `    mode: [http-bridge]\n    launchers: []\n`,
    );
    const bridge = result.read("pet-api", "mcp-http-client.ts");
    expect(bridge).toContain('method: "GET"');
    expect(bridge).toContain('path: "/pets/{id}"');
    expect(bridge).toContain('source: ["id"]');
    expect(bridge).toContain('bodyTarget: ["body"]');
    expect(bridge).toContain('statusTarget: ["status"]');
    expect(bridge).toContain('url: "https://api.example.test"');
    const operations = result.read("pet-api", "mcp-operations.ts");
    expect(operations).toContain("readOnlyHint: true");
    expect(operations).toContain("openWorldHint: true");
    expect(operations).toContain("destructiveHint: false");
    expect(result.read("pet-api", "mcp-server.ts")).toContain("HttpBridgeMcpApplication");
  });

  test("inherits service authentication and preserves no-auth alternatives", () => {
    const result = compileFixture(
      "bridge-auth",
      `
        import "@typespec/http";
        import "@typespex/mcp";
        using TypeSpec.Http;
        using TypeSpex.Mcp;

        @service(#{ title: "Secure API" })
        @server("https://api.example.test")
        @useAuth(BearerAuth | NoAuth)
        @mcpServer(#{ version: "1.0.0" })
        namespace SecureApi {
          @tool @get @route("/value") op read(): string;
        }
      `,
      `    mode: [http-bridge]\n    launchers: []\n`,
    );
    const bridge = result.read("secure-api", "mcp-http-client.ts");
    expect(bridge).toContain('id: "BearerAuth"');
    expect(bridge).toContain('scheme: "Bearer"');
    expect(bridge).toContain("noAuth: true");
  });

  test("maps HTTP JSONL streams to bounded MCP arrays", () => {
    const result = compileFixture(
      "bridge-jsonl",
      `
        import "@typespec/http";
        import "@typespec/http/streams";
        import "@typespex/mcp";
        using TypeSpec.Http;
        using TypeSpec.Http.Streams;
        using TypeSpex.Mcp;

        model Item { id: int32; }
        @service @server("https://api.example.test")
        @mcpServer(#{ version: "1.0.0" })
        namespace StreamsApi {
          @tool @get @route("/items") op list(): JsonlStream<Item>;
        }
      `,
      `    mode: [http-bridge]\n    launchers: []\n`,
    );
    expect(result.read("streams-api", "mcp-http-client.ts")).toContain('kind: "jsonl"');
    expect(result.read("streams-api", "mcp-server.ts")).toContain("readonly Item[]");
  });

  test("accepts native and bridge modes as an array while mapping bridged streams", () => {
    const result = compileFixture(
      "hybrid-jsonl",
      `
        import "@typespec/http";
        import "@typespec/http/streams";
        import "@typespex/mcp";
        using TypeSpec.Http;
        using TypeSpec.Http.Streams;
        using TypeSpex.Mcp;

        model Item { id: int32; }
        @service @server("https://api.example.test")
        @mcpServer(#{ version: "1.0.0" })
        namespace HybridApi {
          @tool @get @route("/items") op list(): JsonlStream<Item>;
        }
      `,
      `    mode: [native, http-bridge]\n    launchers: []\n`,
    );
    expect(result.read("hybrid-api", "mcp-http-client.ts")).toContain('kind: "jsonl"');
    const server = result.read("hybrid-api", "mcp-server.ts");
    expect(server).toContain("HybridMcpApplication");
    expect(server).toContain("readonly Item[]");
  });

  test("unwraps and plans multipart HTTP parts for MCP inputs", () => {
    const result = compileFixture(
      "bridge-multipart",
      `
        import "@typespec/http";
        import "@typespex/mcp";
        using TypeSpec.Http;
        using TypeSpex.Mcp;

        @service @server("https://api.example.test")
        @mcpServer(#{ version: "1.0.0" })
        namespace UploadApi {
          @tool @post @route("/upload")
          op upload(
            @header contentType: "multipart/form-data",
            @multipartBody body: {
              label: HttpPart<string, #{ name: "wire-label" }>;
              files: HttpPart<File>[];
            },
          ): void;
        }
      `,
      `    mode: [http-bridge]\n    launchers: []\n`,
    );
    const server = result.read("upload-api", "mcp-server.ts");
    const operations = result.read("upload-api", "mcp-operations.ts");
    const bridge = result.read("upload-api", "mcp-http-client.ts");
    expect(server).toContain("label: string");
    expect(server).toContain("files: ReadonlyArray<File>");
    expect(operations).toContain('contentEncoding: "base64"');
    expect(bridge).toContain('name: "wire-label"');
    expect(bridge).toContain("multi: true");
    expect(bridge).toContain('source: ["body", "files"]');
  });

  test("projects explicit parameter and return visibility into schemas and handler types", () => {
    const result = compileFixture(
      "visibility",
      `
        import "@typespex/mcp";
        using TypeSpex.Mcp;

        model Pet {
          @visibility(Lifecycle.Create) writeOnly: string;
          @visibility(Lifecycle.Read) readOnly: string;
          @visibility(Lifecycle.Create, Lifecycle.Read) name: string;
        }

        @mcpServer(#{ version: "1.0.0" }) namespace VisibleApi {
          @tool
          @parameterVisibility(Lifecycle.Create)
          @returnTypeVisibility(Lifecycle.Read)
          op update(pet: Pet): Pet;
        }
      `,
      `    launchers: []\n`,
    );
    const models = result.read("visible-api", "models.ts");
    const server = result.read("visible-api", "mcp-server.ts");
    const operations = result.read("visible-api", "mcp-operations.ts");
    expect(models).toContain("export interface PetUpdateInput");
    expect(models).toContain("export interface PetUpdateOutput");
    expect(server).toContain("{ pet: PetUpdateInput }");
    expect(server).toContain("export type UpdateOutput = PetUpdateOutput");
    const inputModel = models.match(/export interface PetUpdateInput \{([\s\S]*?)\n\}/)?.[1];
    const outputModel = models.match(/export interface PetUpdateOutput \{([\s\S]*?)\n\}/)?.[1];
    expect(inputModel).toContain("writeOnly: string");
    expect(inputModel).toContain("name: string");
    expect(inputModel).not.toContain("readOnly");
    expect(outputModel).toContain("readOnly: string");
    expect(outputModel).toContain("name: string");
    expect(outputModel).not.toContain("writeOnly");
    const inputSchema = operations.slice(
      operations.indexOf("const updateInput"),
      operations.indexOf("const updateSuccess"),
    );
    const outputSchema = operations.slice(
      operations.indexOf("const updateSuccess"),
      operations.indexOf("export const mcpTools"),
    );
    expect(inputSchema).toContain('writeOnly: { type: "string" }');
    expect(inputSchema).not.toContain('readOnly: { type: "string" }');
    expect(outputSchema).toContain('readOnly: { type: "string" }');
    expect(outputSchema).not.toContain('writeOnly: { type: "string" }');
  });

  test("emits Temporal semantic types and treats File derivatives as MCP file records", () => {
    const result = compileFixture(
      "temporal-files",
      `
        import "@typespec/http";
        import "@typespex/mcp";
        using TypeSpec.Http;
        using TypeSpex.Mcp;

        model Attachment extends File {}
        model Clock {
          date: plainDate;
          time: plainTime;
          instant: utcDateTime;
          zoned: offsetDateTime;
          elapsed: duration;
        }

        @mcpServer(#{ version: "1.0.0" }) namespace TemporalFiles {
          @tool op inspect(file: Attachment, clock: Clock): Attachment;
        }
      `,
      `    datetime-mode: temporal\n    launchers: []\n`,
    );
    const models = result.read("temporal-files", "models.ts");
    const operations = result.read("temporal-files", "mcp-operations.ts");
    const server = result.read("temporal-files", "mcp-server.ts");
    expect(models).toContain('import type { Temporal } from "@js-temporal/polyfill"');
    expect(models).toContain("date: Temporal.PlainDate");
    expect(models).toContain("time: Temporal.PlainTime");
    expect(models).toContain("instant: Temporal.Instant");
    expect(models).toContain("zoned: Temporal.ZonedDateTime");
    expect(models).toContain("elapsed: Temporal.Duration");
    expect(models).not.toContain("interface Attachment");
    expect(server).toContain("file: File");
    expect(server).toContain("export type InspectOutput = File");
    expect(operations).toContain('temporalKind: "zoned-date-time"');
    expect(operations).toContain('kind: "file"');
  });

  test("reports invalid and duplicate tool names atomically", () => {
    const result = compileFixtureWithDiagnostics(
      "names",
      `
        import "@typespex/mcp";
        using TypeSpex.Mcp;
        @mcpServer(#{ version: "1.0.0" }) namespace Service {
          @tool(#{ name: "bad name" }) op first(): string;
          @tool(#{ name: "duplicate" }) op second(): string;
          @tool(#{ name: "duplicate" }) op third(): string;
          @tool(#{ name: "__proto__" }) op fourth(): string;
        }
      `,
    );
    expect(result.stdout + result.stderr).toContain("bad name");
    expect(result.stdout + result.stderr).toContain('both use the name "duplicate"');
    expect(result.stdout + result.stderr).toContain("__proto__");
    expect(() => result.files("service")).toThrow();
  });

  test("requires service and HTTP bindings in bridge mode", () => {
    const result = compileFixtureWithDiagnostics(
      "bridge-contract",
      `
        import "@typespec/http";
        import "@typespex/mcp";
        using TypeSpex.Mcp;
        @mcpServer(#{ version: "1.0.0" }) namespace Standalone {
          @tool op run(): string;
        }
      `,
      `    mode: [http-bridge]\n    launchers: []\n`,
    );
    expect(result.stdout + result.stderr).toContain("requires every @mcpServer namespace");
    expect(result.stdout + result.stderr).toContain("has no HTTP binding");
  });

  test("rejects the removed both mode in favor of a mode array", () => {
    const result = compileFixtureWithDiagnostics(
      "removed-both-mode",
      `
        import "@typespex/mcp";
        using TypeSpex.Mcp;
        @mcpServer(#{ version: "1.0.0" }) namespace Values {
          @tool op read(): string;
        }
      `,
      `    mode: both\n    launchers: []\n`,
    );
    expect(result.stdout + result.stderr).toContain("both");
  });

  test("preserves literal query fields and rejects fragment-only HTTP data", () => {
    const query = compileFixture(
      "bridge-literal-query",
      `
        import "@typespec/http";
        import "@typespex/mcp";
        using TypeSpec.Http;
        using TypeSpex.Mcp;
        @service @server("https://api.example.test")
        @mcpServer(#{ version: "1.0.0" }) namespace QueryApi {
          @tool @get @route("/search?fixed=full%20text{&q}")
          op search(@query q?: string): string;
        }
      `,
      `    mode: [http-bridge]\n    launchers: []\n`,
    );
    const bridge = query.read("query-api", "mcp-http-client.ts");
    expect(bridge).toContain('literalQuery: [{ name: "fixed", value: "full text" }]');

    const fragment = compileFixtureWithDiagnostics(
      "bridge-fragment",
      `
        import "@typespec/http";
        import "@typespex/mcp";
        using TypeSpec.Http;
        using TypeSpex.Mcp;
        @service @server("https://api.example.test")
        @mcpServer(#{ version: "1.0.0" }) namespace FragmentApi {
          @tool @get @route("/items{#value}")
          op read(@path value: string): string;
        }
      `,
      `    mode: [http-bridge]\n    launchers: []\n`,
    );
    expect(fragment.stdout + fragment.stderr).toContain("fragment style");
    expect(() => fragment.files("fragment-api")).toThrow();
  });

  test("keeps MCP JSON canonical while planning declared HTTP scalar encodings", () => {
    const result = compileFixture(
      "bridge-encodings",
      `
        import "@typespec/http";
        import "@typespex/mcp";
        using TypeSpec.Http;
        using TypeSpex.Mcp;

        model EncodedValues {
          @encode(string) count: int32;
          @encode(string) enabled: boolean;
          @encode("rfc7231") updatedAt: utcDateTime;
          @encode("seconds", float64) ttl: duration;
          @encode("base64url") token: bytes;
        }

        @service @server("https://api.example.test")
        @mcpServer(#{ version: "1.0.0" }) namespace EncodingApi {
          @tool @post @route("/encoded")
          op transform(
            @header when: utcDateTime,
            @query @encode(string) count: int32,
            @body body: EncodedValues,
          ): {
            @header responseWhen: utcDateTime;
            @body body: EncodedValues;
          };
        }
      `,
      `    mode: [http-bridge]\n    launchers: []\n`,
    );
    const operations = result.read("encoding-api", "mcp-operations.ts");
    const bridge = result.read("encoding-api", "mcp-http-client.ts");
    expect(operations).toContain(
      'count: { type: "integer", minimum: -2147483648, maximum: 2147483647 }',
    );
    expect(operations).toContain('enabled: { type: "boolean" }');
    expect(operations).toContain('updatedAt: { type: "string", format: "date-time" }');
    expect(operations).toContain('ttl: { type: "string", format: "duration" }');
    expect(operations).toContain('token: { type: "string", contentEncoding: "base64" }');
    expect(bridge).toContain('encoding: "integer-string"');
    expect(bridge).toContain('encoding: "boolean-string"');
    expect(bridge).toContain('encoding: "rfc7231"');
    expect(bridge).toContain('encoding: "duration-seconds"');
    expect(bridge).toContain('encoding: "base64url"');
  });

  test("rejects unsafe numbers and native streams", () => {
    const unsafe = compileFixtureWithDiagnostics(
      "unsafe-number",
      `
        import "@typespex/mcp";
        using TypeSpex.Mcp;
        @mcpServer(#{ version: "1.0.0" }) namespace Values {
          @tool op read(): int64;
        }
      `,
    );
    expect(unsafe.stdout + unsafe.stderr).toContain("must use @encode(string)");

    const constrained = compileFixture(
      "safe-int64",
      `
        import "@typespex/mcp";
        using TypeSpex.Mcp;
        @minValue(-100) @maxValue(100) scalar SafeInt extends int64;
        @mcpServer(#{ version: "1.0.0" }) namespace Values {
          @tool op read(value: SafeInt): SafeInt;
        }
      `,
    );
    expect(constrained.read("values", "mcp-server.ts")).toContain("value: SafeInt");
    expect(constrained.read("values", "models.ts")).toContain("export type SafeInt = bigint");
    expect(constrained.read("values", "mcp-operations.ts")).toContain('kind: "bigint-number"');

    const stream = compileFixtureWithDiagnostics(
      "native-stream",
      `
        import "@typespec/http/streams";
        import "@typespex/mcp";
        using TypeSpec.Http.Streams;
        using TypeSpex.Mcp;
        @mcpServer(#{ version: "1.0.0" }) namespace Values {
          @tool op read(): JsonlStream<string>;
        }
      `,
    );
    expect(stream.stdout + stream.stderr).toContain("Native MCP tools cannot accept or return");
  });

  test("reports statically overlapping success and error variants", () => {
    const result = compileFixture(
      "overlap",
      `
        import "@typespex/mcp";
        using TypeSpex.Mcp;
        model Success { value: string; }
        @error model Failure { value: string; }
        @mcpServer(#{ version: "1.0.0" }) namespace Results {
          @tool op run(): Success | Failure;
        }
      `,
    );
    expect(result.stdout + result.stderr).toContain("overlapping success and error wire schemas");
    expect(result.read("results", "mcp-server.ts")).toContain(
      "McpTaggedToolHandler<RunInput, RunOutput, RunError>",
    );
  });

  test("classifies error models nested in named unions as modeled errors", () => {
    const result = compileFixture(
      "nested-errors",
      `
        import "@typespex/mcp";
        using TypeSpex.Mcp;
        model Success { value: string; }
        @error model Missing { code: "missing"; }
        @error model Conflict { code: "conflict"; }
        union ApiErrors { missing: Missing, conflict: Conflict }
        @mcpServer(#{ version: "1.0.0" }) namespace Results {
          @tool op run(): Success | ApiErrors;
        }
      `,
    );
    const operations = result.read("results", "mcp-operations.ts");
    const server = result.read("results", "mcp-server.ts");
    expect(operations).toContain("errors: runErrors");
    expect(server).toContain("export type RunOutput = Success");
    expect(server).toContain("export type RunError = Missing | Conflict");
  });

  test("requires {service} for multi-server application modules", () => {
    const result = compileFixtureWithDiagnostics(
      "multi-module",
      `
        import "@typespex/mcp";
        using TypeSpex.Mcp;
        @mcpServer(#{ version: "1.0.0" }) namespace One { @tool op one(): string; }
        @mcpServer(#{ version: "1.0.0" }) namespace Two { @tool op two(): string; }
      `,
      `    application-module: "./application.js"\n`,
    );
    expect(result.stdout + result.stderr).toContain("must contain {service}");
  });
});
