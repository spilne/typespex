import { afterAll, describe, expect, test } from "bun:test";
import {
  cleanupFixtures,
  compileFixture,
  compileFixtureWithDiagnostics,
} from "./compile-fixture.js";

afterAll(cleanupFixtures);

describe("@typespex/mcp emitter", () => {
  test("defaults to library-only output and emits only explicit tools", () => {
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
    expect(result.files("pets")).toEqual(["mcp-operations.ts", "mcp-server.ts", "models.ts"]);
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
    expect(operations).toContain("export type PingInput = Record<string, never>");
    expect(operations).toContain("createSchema<GetPetSuccess>");
    expect(operations).not.toContain("codec:");
  });

  test("emits explicitly selected launchers through separate transport and adapter packages", () => {
    const result = compileFixture(
      "launchers",
      `
        import "@typespex/mcp";
        using TypeSpex.Mcp;
        @mcpServer(#{ version: "1.0.0" }) namespace Tools {
          @tool op ping(): void;
        }
      `,
      `    application-module: "./application.js"\n    launchers: [stdio, node, bun, express, hono]\n`,
    );
    expect(result.files("tools")).toEqual([
      "mcp-bun.ts",
      "mcp-express.ts",
      "mcp-hono.ts",
      "mcp-node.ts",
      "mcp-operations.ts",
      "mcp-server.ts",
      "mcp-stdio.ts",
      "models.ts",
    ]);
    expect(result.read("tools", "mcp-stdio.ts")).toContain("@typespex/mcp-transport-stdio");
    expect(result.read("tools", "mcp-node.ts")).toContain("@typespex/adapter-node");
    expect(result.read("tools", "mcp-bun.ts")).toContain("@typespex/adapter-bun");
    expect(result.read("tools", "mcp-express.ts")).toContain("@typespex/adapter-express");
    expect(result.read("tools", "mcp-hono.ts")).toContain("@typespex/adapter-hono");
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
    const server = result.read("pet-api", "mcp-server.ts");
    expect(server).toContain("McpHttpBridgeApplication");
    expect(server).not.toContain("NativeMcpApplication");
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
    expect(result.read("streams-api", "mcp-operations.ts")).toContain("readonly Item[]");
  });

  test("accepts native and bridge modes as an array while mapping bridged streams", () => {
    const result = compileFixture(
      "multi-mode-jsonl",
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
        namespace MultiModeApi {
          @tool @get @route("/items") op list(): JsonlStream<Item>;
        }
      `,
      `    mode: [native, http-bridge]\n    launchers: []\n`,
    );
    expect(result.read("multi-mode-api", "mcp-http-client.ts")).toContain('kind: "jsonl"');
    const server = result.read("multi-mode-api", "mcp-server.ts");
    expect(server).toContain("NativeMcpApplication<MultiModeApiMcpHandlers>");
    expect(server).toContain("| McpHttpBridgeApplication");
    expect(server).not.toContain("HybridMcpApplication");
    expect(result.read("multi-mode-api", "mcp-operations.ts")).toContain("readonly Item[]");
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
    const operations = result.read("upload-api", "mcp-operations.ts");
    const bridge = result.read("upload-api", "mcp-http-client.ts");
    expect(operations).toContain("label: string");
    expect(operations).toContain("files: ReadonlyArray<File>");
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
    const operations = result.read("visible-api", "mcp-operations.ts");
    expect(models).toContain("export interface PetUpdateInput");
    expect(models).toContain("export interface PetUpdateOutput");
    expect(operations).toContain("{ pet: PetUpdateInput }");
    expect(operations).toContain("export type UpdateOutput = UpdateSuccess");
    expect(operations).toContain("export type UpdateSuccess = PetUpdateOutput");
    const inputModel = models.match(/export interface PetUpdateInput \{([\s\S]*?)\n\}/)?.[1];
    const outputModel = models.match(/export interface PetUpdateOutput \{([\s\S]*?)\n\}/)?.[1];
    expect(inputModel).toContain("writeOnly: string");
    expect(inputModel).toContain("name: string");
    expect(inputModel).not.toContain("readOnly");
    expect(outputModel).toContain("readOnly: string");
    expect(outputModel).toContain("name: string");
    expect(outputModel).not.toContain("writeOnly");
    const inputSchema = operations.slice(
      operations.indexOf("const petSchemaDefinition ="),
      operations.indexOf("const petSchemaDefinition2 ="),
    );
    const outputSchema = operations.slice(
      operations.indexOf("const petSchemaDefinition2 ="),
      operations.indexOf("const updateInput"),
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
    expect(models).toContain('import type { Temporal } from "@js-temporal/polyfill"');
    expect(models).toContain("date: Temporal.PlainDate");
    expect(models).toContain("time: Temporal.PlainTime");
    expect(models).toContain("instant: Temporal.Instant");
    expect(models).toContain("zoned: Temporal.ZonedDateTime");
    expect(models).toContain("elapsed: Temporal.Duration");
    expect(models).not.toContain("interface Attachment");
    expect(operations).toContain("file: File");
    expect(operations).toContain("export type InspectSuccess = File");
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

  test("rejects duplicate launchers as an emitter option schema error", () => {
    const result = compileFixtureWithDiagnostics(
      "duplicate-launchers",
      `
        import "@typespex/mcp";
        using TypeSpex.Mcp;
        @mcpServer(#{ version: "1.0.0" }) namespace Values {
          @tool op read(): string;
        }
      `,
      `    application-module: "./application.js"\n    launchers: [node, node]\n`,
    );
    const diagnostics = result.stdout + result.stderr;
    expect(diagnostics).toContain("launchers");
    expect(diagnostics).toContain("duplicate");
    expect(diagnostics).toContain("Schema violation");
    expect(diagnostics).not.toContain("duplicate-output-path");
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

  test("retains HTTP wire transforms through recursive properties and indexers", () => {
    const result = compileFixture(
      "bridge-recursive-wire",
      `
        import "@typespec/http";
        import "@typespex/mcp";
        using TypeSpec.Http;
        using TypeSpex.Mcp;

        model Node {
          @encodedName("application/json", "wire_label") label: string;
          next?: Node;
        }
        model StringTree extends Record<StringTree> {}

        @service @server("https://api.example.test")
        @mcpServer(#{ version: "1.0.0" }) namespace RecursiveApi {
          @tool @post @route("/nodes")
          op transform(@body body: Node): Node;

          @tool @post @route("/tree")
          op transformTree(@body body: StringTree): StringTree;
        }
      `,
      `    mode: [http-bridge]\n    launchers: []\n`,
    );
    const bridge = result.read("recursive-api", "mcp-http-client.ts");
    expect(bridge).toContain('kind: "definition"');
    expect(bridge).toContain('kind: "ref"');
    expect(bridge).toContain('sourceName: "wire_label"');
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
    expect(constrained.read("values", "mcp-operations.ts")).toContain("value: SafeInt");
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
    expect(stream.stdout + stream.stderr).toContain(
      "Streams cannot be represented by this JSON wire plan",
    );
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
    expect(result.read("results", "mcp-operations.ts")).toContain("requiresTaggedResult: true");
    expect(result.read("results", "mcp-server.ts")).toContain("McpHandlersFor<typeof mcpTools>");
  });

  test("requires tagging unless success and error schemas are provably disjoint", () => {
    const overlapping = compileFixture(
      "literal-broad-overlap",
      `
        import "@typespex/mcp";
        using TypeSpex.Mcp;
        model Success { value: "ok"; }
        @error model Failure { value: string; }
        model IntegerSuccess { value: int32; }
        @error model NumberFailure { value: float64; }
        @pattern("^ok-") scalar OkText extends string;
        model PatternSuccess { value: OkText; }
        @error model TextFailure { value: string; }
        @mcpServer(#{ version: "1.0.0" }) namespace Results {
          @tool op run(): Success | Failure;
          @tool op numeric(): IntegerSuccess | NumberFailure;
          @tool op pattern(): PatternSuccess | TextFailure;
        }
      `,
    );
    expect(overlapping.stdout + overlapping.stderr).toContain(
      "overlapping success and error wire schemas",
    );
    expect(
      overlapping.read("results", "mcp-operations.ts").match(/requiresTaggedResult: true/g),
    ).toHaveLength(3);

    const disjoint = compileFixture(
      "disjoint-results",
      `
        import "@typespex/mcp";
        using TypeSpex.Mcp;
        model Success { kind: "ok"; value: string; }
        @error model Failure { kind: "failed"; message: string; }
        @mcpServer(#{ version: "1.0.0" }) namespace Results {
          @tool op run(): Success | Failure;
        }
      `,
    );
    expect(disjoint.stdout + disjoint.stderr).not.toContain(
      "overlapping success and error wire schemas",
    );
    expect(disjoint.read("results", "mcp-operations.ts")).not.toContain(
      "requiresTaggedResult: true",
    );
  });

  test("shares schema definitions and omits identity codecs", () => {
    const result = compileFixture(
      "shared-contracts",
      `
        import "@typespex/mcp";
        using TypeSpex.Mcp;
        model Pet { id: string; name: string; }
        @mcpServer(#{ version: "1.0.0" }) namespace Pets {
          @tool op getPet(id: string): Pet;
          @tool op listPets(): Pet[];
        }
      `,
    );
    const operations = result.read("pets", "mcp-operations.ts");
    expect(operations.match(/const petSchemaDefinition/g)).toHaveLength(1);
    expect(operations).toContain("createSchema<GetPetSuccess>");
    expect(operations).not.toContain("codec:");
    expect(operations).not.toContain("...{ $schema:");
    expect(result.read("pets", "models.ts")).not.toContain("PetWire");
  });

  test("imports only model types referenced by generated operation aliases", () => {
    const result = compileFixture(
      "strict-type-imports",
      `
        import "@typespex/mcp";
        using TypeSpex.Mcp;
        model Address { city: string; }
        model Owner { name: string; address: Address; }
        model Pet { id: string; owner: Owner; }
        @mcpServer(#{ version: "1.0.0" }) namespace Pets {
          @tool op getPet(Owner: string): Pet;
        }
      `,
    );
    const operations = result.read("pets", "mcp-operations.ts");
    expect(operations).toContain('import type { Pet } from "./models.js";');
    expect(operations).not.toMatch(/import type \{[^\n]*(?:Address|Owner)/);
    const server = result.read("pets", "mcp-server.ts");
    expect(server).toContain("type NativeMcpApplication");
    expect(server).not.toContain("type McpHttpBridgeApplication");
  });

  test("rejects structured media types without a bridge serializer", () => {
    const result = compileFixtureWithDiagnostics(
      "bridge-xml-model",
      `
        import "@typespec/http";
        import "@typespex/mcp";
        using TypeSpec.Http;
        using TypeSpex.Mcp;
        model Pet { id: string; }
        @service @server("https://api.example.test")
        @mcpServer(#{ version: "1.0.0" }) namespace XmlApi {
          @tool @post @route("/pets")
          op create(@header contentType: "application/xml", @body body: Pet): void;
        }
      `,
      `    mode: [http-bridge]\n    launchers: []\n`,
    );
    expect(result.stdout + result.stderr).toContain(
      "application/xml is structured; only scalar text bodies are supported",
    );
    expect(() => result.files("xml-api")).toThrow();
  });

  test("carries bytes as binary even when the declared HTTP media type is textual", () => {
    const result = compileFixture(
      "bridge-xml-bytes",
      `
        import "@typespec/http";
        import "@typespex/mcp";
        using TypeSpec.Http;
        using TypeSpex.Mcp;
        @service @server("https://api.example.test")
        @mcpServer(#{ version: "1.0.0" }) namespace XmlBytesApi {
          @tool @post @route("/document")
          op upload(@header contentType: "application/xml", @body body: bytes): void;
        }
      `,
      `    mode: [http-bridge]\n    launchers: []\n`,
    );
    const bridge = result.read("xml-bytes-api", "mcp-http-client.ts");
    expect(bridge).toContain(
      'mediaTypes: [{ contentType: "application/xml", kind: "binary", value: { kind: "string" } }]',
    );
    expect(result.read("xml-bytes-api", "mcp-operations.ts")).toContain(
      'contentEncoding: "base64"',
    );
    expect(result.read("xml-bytes-api", "mcp-operations.ts")).toContain(
      'required: ["contentType", "body"]',
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
    expect(operations).toContain("errors: runErrors");
    expect(operations).toContain("export type RunSuccess = Success");
    expect(operations).toContain("export type RunError = Missing | Conflict");
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
