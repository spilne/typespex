import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { buildFixturePackages } from "../../../scripts/test-support/package-builds.js";

const repoRoot = resolve(import.meta.dir, "../../..");
const compilerCli = resolve(repoRoot, "example/node_modules/@typespec/compiler/cmd/tsp.js");
const tempDirs: string[] = [];

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
  const directory = mkdtempSync(join(repoRoot, `example/tmp-mcp-${name}-`));
  tempDirs.push(directory);
  const outputDir = join(directory, "generated");
  const sourceFile = join(directory, "main.tsp");
  const configFile = join(directory, "tspconfig.yaml");
  writeFileSync(sourceFile, source);
  writeFileSync(
    configFile,
    `emit:\n  - "@typespex/mcp-emitter"\noptions:\n  "@typespex/mcp-emitter":\n${options}`,
  );
  const process = Bun.spawnSync(
    ["node", compilerCli, "compile", sourceFile, "--config", configFile, "--output-dir", outputDir],
    {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...Bun.env, TYPESPEC_SKIP_COMPILER_RESOLVE: "1" },
    },
  );
  const stdout = stripVTControlCharacters(process.stdout.toString());
  const stderr = stripVTControlCharacters(process.stderr.toString());
  if (expectFailure ? process.exitCode === 0 : process.exitCode !== 0) {
    throw new Error(
      `TypeSpec compile ${expectFailure ? "succeeded unexpectedly" : "failed"}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  const emitterOutput = join(outputDir, "@typespex", "mcp-emitter");
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

export function buildEmitter(): void {
  buildFixturePackages(repoRoot, [
    "mcp-emitter",
    "mcp-http-bridge",
    "mcp-transport-http",
    "mcp-transport-stdio",
  ]);
}
