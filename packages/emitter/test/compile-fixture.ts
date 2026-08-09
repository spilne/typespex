import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const repoRoot = resolve(import.meta.dir, "../../..");
const compilerCli = resolve(repoRoot, "example/node_modules/@typespec/compiler/cmd/tsp.js");
const emitterSourceDir = resolve(repoRoot, "packages/emitter/src");
const emitterBuildArtifact = resolve(repoRoot, "packages/emitter/dist/index.js");
const emitterBuildStamp = resolve(repoRoot, "packages/emitter/dist/.test-build-complete");
const emitterBuildLock = resolve(repoRoot, ".context/test-build-locks/emitter");
const runtimeSourceDir = resolve(repoRoot, "packages/runtime/src");
const runtimeBuildArtifact = resolve(repoRoot, "packages/runtime/dist/server.d.ts");
const runtimeBuildStamp = resolve(repoRoot, "packages/runtime/dist/.test-build-complete");
const runtimeBuildLock = resolve(repoRoot, ".context/test-build-locks/runtime");
const sharedBuildInputs = [
  resolve(repoRoot, "package.json"),
  resolve(repoRoot, "bun.lock"),
  resolve(repoRoot, "tsconfig.base.json"),
];
const emitterBuildInputs = [
  emitterSourceDir,
  resolve(repoRoot, "packages/emitter/package.json"),
  resolve(repoRoot, "packages/emitter/tsconfig.json"),
  ...sharedBuildInputs,
];
const runtimeBuildInputs = [
  runtimeSourceDir,
  resolve(repoRoot, "packages/runtime/package.json"),
  resolve(repoRoot, "packages/runtime/tsconfig.json"),
  ...sharedBuildInputs,
];
const runtimeDeclarationPaths = [
  resolve(repoRoot, "packages/runtime/dist/index.d.ts"),
  resolve(repoRoot, "packages/runtime/dist/server.d.ts"),
];

const tempDirs: string[] = [];
let emitterBuildReady = false;
let runtimeDeclarationsReady = false;

export function cleanupFixtures(): void {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function buildEmitter(): void {
  if (emitterBuildReady) return;
  ensureTestBuild(
    "@typespex/emitter",
    emitterBuildInputs,
    emitterBuildArtifact,
    emitterBuildStamp,
    emitterBuildLock,
    "Emitter",
  );
  emitterBuildReady = true;
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

      const proc = Bun.spawnSync(["bun", "run", "tsc", "--project", generatedTsconfig], {
        cwd: join(repoRoot, "packages/emitter"),
        stdout: "pipe",
        stderr: "pipe",
      });

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
  if (runtimeDeclarationsReady) return;

  // Bun runs test files in parallel workers. Coordinate the declaration build
  // across those workers so they neither stampede `tsc` nor observe partially
  // rewritten output from another worker.
  ensureTestBuild(
    "@typespex/runtime",
    runtimeBuildInputs,
    runtimeBuildArtifact,
    runtimeBuildStamp,
    runtimeBuildLock,
    "Runtime",
  );

  const missing = runtimeDeclarationPaths.filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(
      `Runtime build did not produce declarations required for generated TypeScript typecheck.\n` +
        `Missing:\n${missing.map((path) => `- ${path}`).join("\n")}`,
    );
  }

  runtimeDeclarationsReady = true;
}

const BUILD_LOCK_WAIT_MS = 25;
const BUILD_LOCK_TIMEOUT_MS = 15_000;
const INCOMPLETE_LOCK_STALE_MS = 2_000;
const OWNED_LOCK_STALE_MS = 60_000;

interface BuildLockOwner {
  readonly pid: number;
  readonly token: string;
  readonly createdAt: number;
}

function ensureTestBuild(
  packageName: string,
  inputs: readonly string[],
  artifact: string,
  stamp: string,
  lockDir: string,
  label: string,
): void {
  if (isBuildFresh(inputs, artifact, stamp)) return;

  mkdirSync(resolve(lockDir, ".."), { recursive: true });
  const deadline = Date.now() + BUILD_LOCK_TIMEOUT_MS;
  const owner: BuildLockOwner = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: Date.now(),
  };
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(resolve(lockDir, "owner.json"), JSON.stringify(owner));
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      if (isBuildFresh(inputs, artifact, stamp)) return;
      reclaimAbandonedBuildLock(lockDir);
      if (Date.now() >= deadline) {
        throw new Error(`${label} test build lock timed out: ${lockDir}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, BUILD_LOCK_WAIT_MS);
    }
  }

  try {
    // Another worker may have completed the build immediately before this
    // worker acquired the lock.
    if (isBuildFresh(inputs, artifact, stamp)) return;

    for (;;) {
      const before = fingerprintBuildInputs(inputs);
      rmSync(artifact, { force: true });
      rmSync(stamp, { force: true });

      const proc = Bun.spawnSync(["bun", "run", "--filter", packageName, "build"], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (proc.exitCode !== 0) {
        throw new Error(
          `${label} build failed\nstdout:\n${proc.stdout.toString()}\nstderr:\n${proc.stderr.toString()}`,
        );
      }
      if (!existsSync(artifact)) {
        throw new Error(`${label} build did not produce its expected artifact: ${artifact}`);
      }

      const after = fingerprintBuildInputs(inputs);
      if (before !== after) continue;
      writeFileSync(stamp, after);
      break;
    }
  } finally {
    releaseBuildLock(lockDir, owner.token);
  }
}

function isBuildFresh(inputs: readonly string[], artifact: string, stamp: string): boolean {
  try {
    if (!existsSync(artifact) || !existsSync(stamp)) return false;
    return readFileSync(stamp, "utf8") === fingerprintBuildInputs(inputs);
  } catch {
    // Another worker may be replacing an artifact or stamp while this worker
    // checks it. The lock path will decide which worker rebuilds.
    return false;
  }
}

function fingerprintBuildInputs(inputs: readonly string[]): string {
  const hash = createHash("sha256");
  for (const input of [...inputs].sort()) {
    updateFingerprint(hash, input);
  }
  return hash.digest("hex");
}

function updateFingerprint(hash: ReturnType<typeof createHash>, path: string): void {
  const entry = statSync(path);
  hash.update(path);
  hash.update("\0");
  if (!entry.isDirectory()) {
    hash.update(readFileSync(path));
    hash.update("\0");
    return;
  }

  for (const child of readdirSync(path).sort()) {
    updateFingerprint(hash, join(path, child));
  }
}

function reclaimAbandonedBuildLock(lockDir: string): void {
  if (!isBuildLockAbandoned(lockDir)) return;

  // Only one waiter performs reclamation. Re-read under the guard so an
  // observed lock cannot be confused with a later owner's lock.
  const reclaimGuard = `${lockDir}.reclaim`;
  try {
    mkdirSync(reclaimGuard);
  } catch (error) {
    if (isAlreadyExistsError(error)) return;
    throw error;
  }

  try {
    if (isBuildLockAbandoned(lockDir)) {
      rmSync(lockDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(reclaimGuard, { recursive: true, force: true });
  }
}

function isBuildLockAbandoned(lockDir: string): boolean {
  const owner = readBuildLockOwner(lockDir);
  if (owner) {
    return !isProcessAlive(owner.pid) || Date.now() - owner.createdAt >= OWNED_LOCK_STALE_MS;
  }
  try {
    return Date.now() - statSync(lockDir).mtimeMs >= INCOMPLETE_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function readBuildLockOwner(lockDir: string): BuildLockOwner | undefined {
  try {
    const value = JSON.parse(
      readFileSync(resolve(lockDir, "owner.json"), "utf8"),
    ) as Partial<BuildLockOwner>;
    if (
      typeof value.pid !== "number" ||
      typeof value.token !== "string" ||
      typeof value.createdAt !== "number"
    ) {
      return undefined;
    }
    return value as BuildLockOwner;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
}

function releaseBuildLock(lockDir: string, token: string): void {
  if (readBuildLockOwner(lockDir)?.token !== token) return;
  rmSync(lockDir, { recursive: true, force: true });
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
