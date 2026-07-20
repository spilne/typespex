import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const repoRoot = resolve(import.meta.dir, "../../..");
const compilerCli = resolve(repoRoot, "example/node_modules/@typespec/compiler/cmd/tsp.js");
const runtimeDeclarationPaths = [
  resolve(repoRoot, "packages/runtime/dist/index.d.ts"),
  resolve(repoRoot, "packages/runtime/dist/server.d.ts"),
];

const tempDirs: string[] = [];
let runtimeDeclarationsReady = false;

export function cleanupFixtures(): void {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function buildEmitter(): void {
  const proc = Bun.spawnSync(
    ["bun", "run", "--filter", "@typespex/emitter", "build"],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
  );

  if (proc.exitCode !== 0) {
    throw new Error(
      `Emitter build failed\nstdout:\n${proc.stdout.toString()}\nstderr:\n${proc.stderr.toString()}`,
    );
  }
}

export interface CompileResult {
  outputDir: string;
  readFile(serviceDirOrFile: string, fileName?: string): string;
  fileExists(serviceDirOrFile: string, fileName?: string): boolean;
  listFiles(serviceDir: string): string[];
  typecheck(serviceDir: string, extraFiles?: Record<string, string>): void;
}

export interface CompileDiagnostics {
  readonly stdout: string;
  readonly stderr: string;
}

export interface CompileResultWithDiagnostics extends CompileResult {
  readonly diagnostics: CompileDiagnostics;
}

export function compileFixture(
  name: string,
  source: string,
  configExtra = "",
  extraFiles?: Record<string, string>,
): CompileResult {
  const { result } = runCompiler(name, source, configExtra, extraFiles, { expectFailure: false });
  return result;
}

/**
 * Runs the compiler expecting it to surface diagnostics (non-zero exit).
 * Returns captured stdout/stderr and file-reading helpers so tests can verify
 * that diagnostic failures suppress generated output.
 */
export function compileFixtureExpectingDiagnostics(
  name: string,
  source: string,
  configExtra = "",
  extraFiles?: Record<string, string>,
): CompileResultWithDiagnostics {
  const { result, diagnostics } = runCompiler(name, source, configExtra, extraFiles, {
    expectFailure: true,
  });
  return { ...result, diagnostics };
}

/** Runs the compiler and returns diagnostics regardless of its exit code. */
export function compileFixtureCollectingDiagnostics(
  name: string,
  source: string,
  configExtra = "",
  extraFiles?: Record<string, string>,
): CompileResultWithDiagnostics {
  const { result, diagnostics } = runCompiler(name, source, configExtra, extraFiles, {
    expectFailure: "allow",
  });
  return { ...result, diagnostics };
}

function runCompiler(
  name: string,
  source: string,
  configExtra: string,
  extraFiles: Record<string, string> | undefined,
  options: { expectFailure: boolean | "allow" },
): { result: CompileResult; diagnostics: CompileDiagnostics } {
  const fixtureDir = mkdtempSync(join(repoRoot, `example/tmp-typespex-${name}-`));
  tempDirs.push(fixtureDir);

  const sourceFile = join(fixtureDir, "main.tsp");
  const configFile = join(fixtureDir, "tspconfig.yaml");
  const outputDir = join(fixtureDir, "generated");

  writeFileSync(sourceFile, source);
  writeFileSync(
    configFile,
    `emit:\n  - "@typespex/emitter"\noptions:\n  "@typespex/emitter":\n    emitter-output-dir: "{output-dir}"\n${configExtra}`,
  );

  if (extraFiles) {
    for (const [name, content] of Object.entries(extraFiles)) {
      writeFileSync(join(fixtureDir, name), content);
    }
  }

  const proc = Bun.spawnSync(
    ["node", compilerCli, "compile", sourceFile, "--config", configFile, "--output-dir", outputDir],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
  );

  const diagnostics: CompileDiagnostics = {
    stdout: stripVTControlCharacters(proc.stdout.toString()),
    stderr: stripVTControlCharacters(proc.stderr.toString()),
  };

  if (options.expectFailure === true && proc.exitCode === 0) {
    throw new Error(
      `TypeSpec compile succeeded but diagnostics were expected\nstdout:\n${diagnostics.stdout}\nstderr:\n${diagnostics.stderr}`,
    );
  }

  if (options.expectFailure === false && proc.exitCode !== 0) {
    throw new Error(
      `TypeSpec compile failed\nstdout:\n${diagnostics.stdout}\nstderr:\n${diagnostics.stderr}`,
    );
  }

  const result: CompileResult = {
    outputDir,
    readFile(serviceDirOrFile: string, fileName?: string): string {
      const path = fileName
        ? join(outputDir, serviceDirOrFile, fileName)
        : join(outputDir, serviceDirOrFile);
      return readFileSync(path, "utf8");
    },
    fileExists(serviceDirOrFile: string, fileName?: string): boolean {
      const path = fileName
        ? join(outputDir, serviceDirOrFile, fileName)
        : join(outputDir, serviceDirOrFile);
      return existsSync(path);
    },
    listFiles(serviceDir: string): string[] {
      const path = join(outputDir, serviceDir);
      return existsSync(path) ? readdirSync(path).sort() : [];
    },
    typecheck(serviceDir: string, extraFiles?: Record<string, string>): void {
      ensureRuntimeDeclarationsExist();

      if (extraFiles) {
        for (const [name, content] of Object.entries(extraFiles)) {
          writeFileSync(join(outputDir, serviceDir, name), content);
        }
      }

      const generatedTsconfig = join(fixtureDir, "tsconfig.generated.json");
      writeFileSync(
        generatedTsconfig,
        JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              module: "NodeNext",
              moduleResolution: "NodeNext",
              strict: true,
              skipLibCheck: true,
              noEmit: true,
              esModuleInterop: true,
              isolatedModules: true,
              lib: ["ES2022", "DOM"],
              baseUrl: repoRoot,
              paths: {
                "@typespex/runtime": ["packages/runtime/dist/index.d.ts"],
                "@typespex/runtime/server": ["packages/runtime/dist/server.d.ts"],
              },
            },
            include: [`generated/${serviceDir}/*.ts`],
          },
          null,
          2,
        ),
      );

      const proc = Bun.spawnSync(
        ["bun", "run", "tsc", "--project", generatedTsconfig],
        { cwd: join(repoRoot, "packages/emitter"), stdout: "pipe", stderr: "pipe" },
      );

      if (proc.exitCode !== 0) {
        throw new Error(
          `Generated TypeScript typecheck failed\nstdout:\n${proc.stdout.toString()}\nstderr:\n${proc.stderr.toString()}`,
        );
      }
    },
  };

  return { result, diagnostics };
}

function ensureRuntimeDeclarationsExist(): void {
  if (runtimeDeclarationsReady && runtimeDeclarationPaths.every((path) => existsSync(path))) {
    return;
  }

  if (runtimeDeclarationPaths.some((path) => !existsSync(path))) {
    const proc = Bun.spawnSync(
      ["bun", "run", "--filter", "@typespex/runtime", "build"],
      { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
    );

    if (proc.exitCode !== 0) {
      throw new Error(
        `Runtime build failed before generated TypeScript typecheck\n` +
          `stdout:\n${proc.stdout.toString()}\nstderr:\n${proc.stderr.toString()}`,
      );
    }
  }

  const missing = runtimeDeclarationPaths.filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(
      `Runtime build did not produce declarations required for generated TypeScript typecheck.\n` +
        `Missing:\n${missing.map((path) => `- ${path}`).join("\n")}`,
    );
  }

  runtimeDeclarationsReady = true;
}
