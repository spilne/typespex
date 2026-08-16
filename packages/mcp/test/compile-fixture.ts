import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const repoRoot = resolve(import.meta.dir, "../../..");
const compilerCli = resolve(repoRoot, "example/node_modules/@typespec/compiler/cmd/tsp.js");
const tempDirs: string[] = [];
let built = false;

export interface CompileResult {
  readonly outputDir: string;
  readonly stdout: string;
  readonly stderr: string;
  read(service: string, file: string): string;
  files(service: string): string[];
}

export function cleanupFixtures(): void {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
}

export function compileFixture(
  name: string,
  source: string,
  options = "    launchers: []\n",
): CompileResult {
  return compile(name, source, options, false);
}

export function compileFixtureWithDiagnostics(
  name: string,
  source: string,
  options = "    launchers: []\n",
): CompileResult {
  return compile(name, source, options, true);
}

function compile(
  name: string,
  source: string,
  options: string,
  expectFailure: boolean,
): CompileResult {
  ensureBuilt();
  const directory = mkdtempSync(join(repoRoot, `example/tmp-mcp-${name}-`));
  tempDirs.push(directory);
  const outputDir = join(directory, "generated");
  const sourceFile = join(directory, "main.tsp");
  const configFile = join(directory, "tspconfig.yaml");
  writeFileSync(sourceFile, source);
  writeFileSync(configFile, `emit:\n  - "@typespex/mcp"\noptions:\n  "@typespex/mcp":\n${options}`);
  const process = Bun.spawnSync(
    ["node", compilerCli, "compile", sourceFile, "--config", configFile, "--output-dir", outputDir],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
  );
  const stdout = stripVTControlCharacters(process.stdout.toString());
  const stderr = stripVTControlCharacters(process.stderr.toString());
  if (expectFailure ? process.exitCode === 0 : process.exitCode !== 0) {
    throw new Error(
      `TypeSpec compile ${expectFailure ? "succeeded unexpectedly" : "failed"}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  const emitterOutput = join(outputDir, "@typespex", "mcp");
  return {
    outputDir: emitterOutput,
    stdout,
    stderr,
    read(service, file) {
      return readFileSync(join(emitterOutput, service, file), "utf8");
    },
    files(service) {
      return readdirSync(join(emitterOutput, service)).sort();
    },
  };
}

function ensureBuilt(): void {
  if (built) return;
  for (const packageName of [
    "@typespex/runtime",
    "@typespex/codegen",
    "@typespex/mcp-runtime",
    "@typespex/mcp",
  ]) {
    const process = Bun.spawnSync(["bun", "run", "--filter", packageName, "build"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (process.exitCode !== 0) {
      throw new Error(
        `Failed to build ${packageName}:\n${process.stdout.toString()}\n${process.stderr.toString()}`,
      );
    }
  }
  built = true;
}
