import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const compilerCli = resolve(repoRoot, "example/node_modules/@typespec/compiler/cmd/tsp.js");

const tempDirs: string[] = [];

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
}

export function compileFixture(
  name: string,
  source: string,
  configExtra = "",
  extraFiles?: Record<string, string>,
): CompileResult {
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

  if (proc.exitCode !== 0) {
    throw new Error(
      `TypeSpec compile failed\nstdout:\n${proc.stdout.toString()}\nstderr:\n${proc.stderr.toString()}`,
    );
  }

  return {
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
  };
}
