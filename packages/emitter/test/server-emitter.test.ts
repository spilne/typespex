import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const compilerCli = resolve(repoRoot, "example/node_modules/@typespec/compiler/cmd/tsp.js");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeAll(() => {
  const proc = Bun.spawnSync(
    ["bun", "run", "--filter", "@typespex/emitter", "build"],
    {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  if (proc.exitCode !== 0) {
    throw new Error(
      `Emitter build failed\nstdout:\n${proc.stdout.toString()}\nstderr:\n${proc.stderr.toString()}`,
    );
  }
});

describe("@typespex/emitter server output", () => {
  test("emits FP server contract files", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "typespex-emitter-"));
    tempDirs.push(outputDir);

    const proc = Bun.spawnSync(
      [
        "node",
        compilerCli,
        "compile",
        "example/main.tsp",
        "--config",
        "example/tspconfig.yaml",
        "--output-dir",
        outputDir,
      ],
      {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    if (proc.exitCode !== 0) {
      throw new Error(
        `TypeSpec compile failed\nstdout:\n${proc.stdout.toString()}\nstderr:\n${proc.stderr.toString()}`,
      );
    }

    const serverFile = join(outputDir, "server.ts");
    const hintsFile = join(outputDir, "server-hints.ts");
    const operationsFile = join(outputDir, "server-operations.ts");
    const routerFile = join(outputDir, "server-router.ts");

    expect(existsSync(serverFile)).toBe(true);
    expect(existsSync(hintsFile)).toBe(true);
    expect(existsSync(operationsFile)).toBe(true);
    expect(existsSync(routerFile)).toBe(true);

    const serverText = readFileSync(serverFile, "utf8");
    const hintsText = readFileSync(hintsFile, "utf8");
    const operationsText = readFileSync(operationsFile, "utf8");
    const routerText = readFileSync(routerFile, "utf8");

    expect(serverText).toContain('import type { MatchedRequestContext, OperationHandler } from "@typespex/runtime/server";');
    expect(serverText).toContain("export interface PetsServer<Ctx = MatchedRequestContext> {");
    expect(serverText).toContain("readonly read: OperationHandler<{ petId: string }, NotFoundError, Pet, Ctx>;");

    expect(hintsText).toContain('import { createHintKey } from "@typespex/runtime/server";');
    expect(hintsText).toContain('export const typeSpecDocHint = createHintKey<string>("TypeSpec.doc");');
    expect(hintsText).toContain('export const typeSpecSummaryHint = createHintKey<string>("TypeSpec.summary");');
    expect(hintsText).toContain('export const typeSpecTagsHint = createHintKey<readonly string[]>("TypeSpec.tags");');

    expect(operationsText).toContain('import type { ServerOperation } from "@typespex/runtime/server";');
    expect(operationsText).toContain("decodeFields");
    expect(operationsText).toContain("mapNFields");
    expect(operationsText).toContain("mapFieldDecoder");
    expect(operationsText).toContain("decodeJsonBody");
    expect(operationsText).toContain('import * as ServerHints from "./server-hints.js";');
    expect(operationsText).toContain("export const PetsOperations = {");
    expect(operationsText).toContain("endpoint: {");
    expect(operationsText).toContain('name: "PetStore"');
    expect(operationsText).toContain('operationId: "Pets.read"');
    // Grouped codecs object
    expect(operationsText).toContain("const PetsCodecs = {");
    expect(operationsText).toContain("read: mapFieldDecoder(");
    expect(operationsText).toContain('requiredPath("petId", stringCodec),');
    expect(operationsText).toContain("create: objectCodec<CreatePetInput>({");
    expect(operationsText).toContain("optional(stringCodec)");
    // Operations reference codecs by group
    expect(operationsText).toContain("decodeFields<{ petId: string }>(PetsCodecs.read, request, pathParams)");
    expect(operationsText).toContain("decodeJsonBody<CreatePetInput>(request, PetsCodecs.create)");
    expect(operationsText).toContain("encodeError: (error: NotFoundError) => {");
    // Expression-body arrows for simple cases
    expect(operationsText).toContain("encodeError: (error: never) => absurd(error),");

    expect(routerText).toContain('import { bindRoute, createHttpRouter } from "@typespex/runtime/server";');
    expect(routerText).toContain("export function createPetStoreServerRouter<Ctx extends MatchedRequestContext>");
    expect(routerText).toContain("bindRoute(PetsOperations.read, implementation.Pets.read)");
  });

  test("emits standalone operations as top-level service members", () => {
    const fixtureDir = mkdtempSync(join(repoRoot, "example/tmp-typespex-standalone-"));
    tempDirs.push(fixtureDir);

    const sourceFile = join(fixtureDir, "main.tsp");
    const configFile = join(fixtureDir, "tspconfig.yaml");
    const outputDir = join(fixtureDir, "generated");

    writeFileSync(
      sourceFile,
      `import "@typespec/http";

using TypeSpec.Http;

@service(#{ title: "StatusApi" })
namespace StatusApi;

model HealthStatus {
  ok: boolean;
}

@route("/health")
@get
op health(): HealthStatus;
`,
    );

    writeFileSync(
      configFile,
      `emit:
  - "@typespex/emitter"
options:
  "@typespex/emitter":
    emitter-output-dir: "{output-dir}"
`,
    );

    const proc = Bun.spawnSync(
      [
        "node",
        compilerCli,
        "compile",
        sourceFile,
        "--config",
        configFile,
        "--output-dir",
        outputDir,
      ],
      {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    if (proc.exitCode !== 0) {
      throw new Error(
        `TypeSpec compile failed\nstdout:\n${proc.stdout.toString()}\nstderr:\n${proc.stderr.toString()}`,
      );
    }

    const serverText = readFileSync(join(outputDir, "server.ts"), "utf8");
    const operationsText = readFileSync(join(outputDir, "server-operations.ts"), "utf8");
    const routerText = readFileSync(join(outputDir, "server-router.ts"), "utf8");

    expect(serverText).toContain("export interface StatusApiServer<Ctx = MatchedRequestContext> {");
    expect(serverText).toContain("readonly health: OperationHandler<Record<string, never>, never, HealthStatus, Ctx>;");
    expect(serverText).not.toContain("export interface OperationsServer");

    expect(operationsText).toContain("export const StatusApiOperations = {");
    expect(operationsText).toContain('operationId: "StatusApi.health"');
    expect(operationsText).toContain("namespaces: [");
    expect(operationsText).toContain("} satisfies ServerOperation<Record<string, never>, never, HealthStatus>,");

    expect(routerText).toContain("import { StatusApiOperations } from \"./server-operations.js\";");
    expect(routerText).toContain("bindRoute(StatusApiOperations.health, implementation.health)");
  });

  test("emits importable custom decorator hints for middleware", () => {
    const fixtureDir = mkdtempSync(join(repoRoot, "example/tmp-typespex-hints-"));
    tempDirs.push(fixtureDir);

    const sourceFile = join(fixtureDir, "main.tsp");
    const configFile = join(fixtureDir, "tspconfig.yaml");
    const libFile = join(fixtureDir, "lib.js");
    const outputDir = join(fixtureDir, "generated");

    writeFileSync(
      sourceFile,
      `import "@typespec/http";
import "./lib.js";

using TypeSpec.Http;
using TypeSpec.Reflection;

extern dec auth(target: Operation, scope: valueof string);

@service(#{ title: "SecureApi" })
namespace SecureApi {
  @route("/admin")
  @get
  @auth("admin")
  op admin(): string;
}
`,
    );

    writeFileSync(
      libFile,
      `export function $auth() {}`,
    );

    writeFileSync(
      configFile,
      `emit:
  - "@typespex/emitter"
options:
  "@typespex/emitter":
    emitter-output-dir: "{output-dir}"
`,
    );

    const proc = Bun.spawnSync(
      [
        "node",
        compilerCli,
        "compile",
        sourceFile,
        "--config",
        configFile,
        "--output-dir",
        outputDir,
      ],
      {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    if (proc.exitCode !== 0) {
      throw new Error(
        `TypeSpec compile failed\nstdout:\n${proc.stdout.toString()}\nstderr:\n${proc.stderr.toString()}`,
      );
    }

    const hintsText = readFileSync(join(outputDir, "server-hints.ts"), "utf8");
    const operationsText = readFileSync(join(outputDir, "server-operations.ts"), "utf8");

    expect(hintsText).toContain('export const authHint = createHintKey<string>("auth");');
    expect(operationsText).toContain('import * as ServerHints from "./server-hints.js";');
    expect(operationsText).toContain('hints: createHints([[ServerHints.authHint, "admin"]])');
  });

  test("emits enum types and union types correctly", () => {
    const fixtureDir = mkdtempSync(join(repoRoot, "example/tmp-typespex-enums-"));
    tempDirs.push(fixtureDir);

    const sourceFile = join(fixtureDir, "main.tsp");
    const configFile = join(fixtureDir, "tspconfig.yaml");
    const outputDir = join(fixtureDir, "generated");

    writeFileSync(
      sourceFile,
      `import "@typespec/http";

using TypeSpec.Http;

@service(#{ title: "EnumApi" })
namespace EnumApi;

enum PetKind {
  Dog: "dog",
  Cat: "cat",
  Bird: "bird",
}

model Pet {
  id: string;
  name: string;
  kind: PetKind;
  tag?: string;
}

model NotFoundError {
  @header statusCode: 404;
  code: "NOT_FOUND";
  message: string;
}

@route("/pets")
interface Pets {
  @get read(@path petId: string): Pet | NotFoundError;
}
`,
    );

    writeFileSync(
      configFile,
      `emit:
  - "@typespex/emitter"
options:
  "@typespex/emitter":
    emitter-output-dir: "{output-dir}"
`,
    );

    const proc = Bun.spawnSync(
      [
        "node",
        compilerCli,
        "compile",
        sourceFile,
        "--config",
        configFile,
        "--output-dir",
        outputDir,
      ],
      {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    if (proc.exitCode !== 0) {
      throw new Error(
        `TypeSpec compile failed\nstdout:\n${proc.stdout.toString()}\nstderr:\n${proc.stderr.toString()}`,
      );
    }

    const modelsText = readFileSync(join(outputDir, "models.ts"), "utf8");

    // Enum should be emitted as a union of literal types
    expect(modelsText).toContain('"dog" | "cat" | "bird"');
    // Pet model should reference enum type
    expect(modelsText).toContain("kind: ");
    // NotFoundError model should exist
    expect(modelsText).toContain("NotFoundError");
  });

  test("emits operations with optional query and header params", () => {
    const fixtureDir = mkdtempSync(join(repoRoot, "example/tmp-typespex-params-"));
    tempDirs.push(fixtureDir);

    const sourceFile = join(fixtureDir, "main.tsp");
    const configFile = join(fixtureDir, "tspconfig.yaml");
    const outputDir = join(fixtureDir, "generated");

    writeFileSync(
      sourceFile,
      `import "@typespec/http";

using TypeSpec.Http;

@service(#{ title: "ParamsApi" })
namespace ParamsApi;

model Item {
  id: string;
  name: string;
}

@route("/items")
interface Items {
  @get list(
    @query limit?: int32,
    @query offset?: int32,
    @header("x-request-id") requestId?: string,
  ): Item[];
}
`,
    );

    writeFileSync(
      configFile,
      `emit:
  - "@typespex/emitter"
options:
  "@typespex/emitter":
    emitter-output-dir: "{output-dir}"
`,
    );

    const proc = Bun.spawnSync(
      [
        "node",
        compilerCli,
        "compile",
        sourceFile,
        "--config",
        configFile,
        "--output-dir",
        outputDir,
      ],
      {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    if (proc.exitCode !== 0) {
      throw new Error(
        `TypeSpec compile failed\nstdout:\n${proc.stdout.toString()}\nstderr:\n${proc.stderr.toString()}`,
      );
    }

    const operationsText = readFileSync(join(outputDir, "server-operations.ts"), "utf8");
    const serverText = readFileSync(join(outputDir, "server.ts"), "utf8");

    // Should use mapNFields for multiple params
    expect(operationsText).toContain("mapNFields");
    // Should have optional query decoders
    expect(operationsText).toContain("optionalQuery");
    // Should have optional header decoder
    expect(operationsText).toContain("optionalHeader");
    // Header name should be lowercased
    expect(operationsText).toContain('"x-request-id"');

    // Server interface should have optional params
    expect(serverText).toContain("limit?: number");
    expect(serverText).toContain("offset?: number");
    expect(serverText).toContain("requestId?: string");
  });

  test("emits void response as 204 with null body", () => {
    const fixtureDir = mkdtempSync(join(repoRoot, "example/tmp-typespex-void-"));
    tempDirs.push(fixtureDir);

    const sourceFile = join(fixtureDir, "main.tsp");
    const configFile = join(fixtureDir, "tspconfig.yaml");
    const outputDir = join(fixtureDir, "generated");

    writeFileSync(
      sourceFile,
      `import "@typespec/http";

using TypeSpec.Http;

@service(#{ title: "VoidApi" })
namespace VoidApi;

@route("/items")
interface Items {
  @delete remove(@path itemId: string): void;
}
`,
    );

    writeFileSync(
      configFile,
      `emit:
  - "@typespex/emitter"
options:
  "@typespex/emitter":
    emitter-output-dir: "{output-dir}"
`,
    );

    const proc = Bun.spawnSync(
      [
        "node",
        compilerCli,
        "compile",
        sourceFile,
        "--config",
        configFile,
        "--output-dir",
        outputDir,
      ],
      {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    if (proc.exitCode !== 0) {
      throw new Error(
        `TypeSpec compile failed\nstdout:\n${proc.stdout.toString()}\nstderr:\n${proc.stderr.toString()}`,
      );
    }

    const operationsText = readFileSync(join(outputDir, "server-operations.ts"), "utf8");
    const serverText = readFileSync(join(outputDir, "server.ts"), "utf8");

    // Void response should use 204
    expect(operationsText).toContain("new Response(null, { status: 204 })");
    // Error type should be never
    expect(serverText).toContain("OperationHandler<{ itemId: string }, never, void, Ctx>");
  });

  test("emits operations with path + query + body combined", () => {
    const fixtureDir = mkdtempSync(join(repoRoot, "example/tmp-typespex-combined-"));
    tempDirs.push(fixtureDir);

    const sourceFile = join(fixtureDir, "main.tsp");
    const configFile = join(fixtureDir, "tspconfig.yaml");
    const outputDir = join(fixtureDir, "generated");

    writeFileSync(
      sourceFile,
      `import "@typespec/http";

using TypeSpec.Http;

@service(#{ title: "CombinedApi" })
namespace CombinedApi;

model UpdatePayload {
  name: string;
  tags?: string[];
}

model Item {
  id: string;
  name: string;
  tags?: string[];
}

@route("/items")
interface Items {
  @put update(@path itemId: string, @query dryRun?: boolean, @body body: UpdatePayload): Item;
}
`,
    );

    writeFileSync(
      configFile,
      `emit:
  - "@typespex/emitter"
options:
  "@typespex/emitter":
    emitter-output-dir: "{output-dir}"
`,
    );

    const proc = Bun.spawnSync(
      [
        "node",
        compilerCli,
        "compile",
        sourceFile,
        "--config",
        configFile,
        "--output-dir",
        outputDir,
      ],
      {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    if (proc.exitCode !== 0) {
      throw new Error(
        `TypeSpec compile failed\nstdout:\n${proc.stdout.toString()}\nstderr:\n${proc.stderr.toString()}`,
      );
    }

    const operationsText = readFileSync(join(outputDir, "server-operations.ts"), "utf8");

    // Combined case: fields + body decoder
    expect(operationsText).toContain("decodeFieldsAndBody");
    // Should have requiredPath for itemId
    expect(operationsText).toContain('requiredPath("itemId"');
    // Should have optionalQuery for dryRun
    expect(operationsText).toContain("optionalQuery");
    // Body codec
    expect(operationsText).toContain("objectCodec<UpdatePayload>");
  });

  test("emits nested namespace operations with namespace metadata", () => {
    const fixtureDir = mkdtempSync(join(repoRoot, "example/tmp-typespex-nested-"));
    tempDirs.push(fixtureDir);

    const sourceFile = join(fixtureDir, "main.tsp");
    const configFile = join(fixtureDir, "tspconfig.yaml");
    const outputDir = join(fixtureDir, "generated");

    writeFileSync(
      sourceFile,
      `import "@typespec/http";

using TypeSpec.Http;

@service(#{ title: "NestedApi" })
namespace NestedApi;

namespace Admin {
  model Config {
    key: string;
    value: string;
  }

  @route("/admin/config")
  @get
  op getConfig(): Config;
}
`,
    );

    writeFileSync(
      configFile,
      `emit:
  - "@typespex/emitter"
options:
  "@typespex/emitter":
    emitter-output-dir: "{output-dir}"
`,
    );

    const proc = Bun.spawnSync(
      [
        "node",
        compilerCli,
        "compile",
        sourceFile,
        "--config",
        configFile,
        "--output-dir",
        outputDir,
      ],
      {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    if (proc.exitCode !== 0) {
      throw new Error(
        `TypeSpec compile failed\nstdout:\n${proc.stdout.toString()}\nstderr:\n${proc.stderr.toString()}`,
      );
    }

    const operationsText = readFileSync(join(outputDir, "server-operations.ts"), "utf8");

    // Should have namespace metadata
    expect(operationsText).toContain("namespaces:");
    expect(operationsText).toContain('"Admin"');
  });

  test("emits array response types correctly", () => {
    const fixtureDir = mkdtempSync(join(repoRoot, "example/tmp-typespex-arrays-"));
    tempDirs.push(fixtureDir);

    const sourceFile = join(fixtureDir, "main.tsp");
    const configFile = join(fixtureDir, "tspconfig.yaml");
    const outputDir = join(fixtureDir, "generated");

    writeFileSync(
      sourceFile,
      `import "@typespec/http";

using TypeSpec.Http;

@service(#{ title: "ArrayApi" })
namespace ArrayApi;

model Tag {
  name: string;
  count: int32;
}

@route("/tags")
interface Tags {
  @get list(): Tag[];
  @post create(@body body: Tag): Tag;
}
`,
    );

    writeFileSync(
      configFile,
      `emit:
  - "@typespex/emitter"
options:
  "@typespex/emitter":
    emitter-output-dir: "{output-dir}"
`,
    );

    const proc = Bun.spawnSync(
      [
        "node",
        compilerCli,
        "compile",
        sourceFile,
        "--config",
        configFile,
        "--output-dir",
        outputDir,
      ],
      {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    if (proc.exitCode !== 0) {
      throw new Error(
        `TypeSpec compile failed\nstdout:\n${proc.stdout.toString()}\nstderr:\n${proc.stderr.toString()}`,
      );
    }

    const serverText = readFileSync(join(outputDir, "server.ts"), "utf8");
    const modelsText = readFileSync(join(outputDir, "models.ts"), "utf8");

    // Array response type
    expect(serverText).toContain("Tag[]");
    // Model should be emitted
    expect(modelsText).toContain("export interface Tag {");
    expect(modelsText).toContain("name: string;");
    expect(modelsText).toContain("count: number;");
  });
});

describe("toColonPath", () => {
  let toColonPath: (path: string) => string;

  beforeAll(async () => {
    const mod = await import("../dist/emit-server-common.js");
    toColonPath = mod.toColonPath;
  });

  test("converts {param} to :param", () => {
    expect(toColonPath("/pets/{petId}")).toBe("/pets/:petId");
  });

  test("converts multiple params", () => {
    expect(toColonPath("/users/{userId}/posts/{postId}")).toBe("/users/:userId/posts/:postId");
  });

  test("no-op on paths without params", () => {
    expect(toColonPath("/health")).toBe("/health");
  });

  test("handles root path", () => {
    expect(toColonPath("/")).toBe("/");
  });
});
