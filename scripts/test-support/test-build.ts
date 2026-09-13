import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

const BUILD_LOCK_WAIT_MS = 25;
const BUILD_LOCK_TIMEOUT_MS = 120_000;
const INCOMPLETE_LOCK_STALE_MS = 2_000;

interface BuildLockOwner {
  readonly pid: number;
  readonly token: string;
  readonly createdAt: number;
}

export interface TestBuild {
  readonly packageName: string;
  readonly repoRoot: string;
  readonly inputs: readonly string[];
  readonly artifacts: readonly string[];
  readonly stamp: string;
  readonly lockDir: string;
}

export function ensureTestBuild(build: TestBuild): void {
  const { packageName, repoRoot, inputs, artifacts, stamp, lockDir } = build;
  const label = packageName;
  if (isBuildFresh(inputs, artifacts, stamp)) return;

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
      if (isBuildFresh(inputs, artifacts, stamp)) return;
      reclaimAbandonedBuildLock(lockDir);
      if (Date.now() >= deadline) {
        throw new Error(
          `${label} test build lock timed out: ${lockDir}. ` +
            "If no fixture build is running, remove this lock directory and retry.",
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, BUILD_LOCK_WAIT_MS);
    }
  }

  try {
    // Another worker may have completed the build immediately before this
    // worker acquired the lock.
    if (isBuildFresh(inputs, artifacts, stamp)) return;

    for (;;) {
      const before = fingerprintBuildInputs(inputs);
      for (const artifact of artifacts) rmSync(artifact, { force: true });
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
      const missing = artifacts.filter((artifact) => !existsSync(artifact));
      if (missing.length > 0) {
        throw new Error(
          `${label} build did not produce its expected artifacts: ${missing.join(", ")}`,
        );
      }

      const after = fingerprintBuildInputs(inputs);
      if (before !== after) continue;
      writeFileSync(stamp, JSON.stringify({ inputs: after, output: fingerprintOutput(stamp) }));
      break;
    }
  } finally {
    releaseBuildLock(lockDir, owner.token);
  }
}

function isBuildFresh(
  inputs: readonly string[],
  artifacts: readonly string[],
  stamp: string,
): boolean {
  try {
    if (artifacts.some((artifact) => !existsSync(artifact)) || !existsSync(stamp)) return false;
    const saved = JSON.parse(readFileSync(stamp, "utf8"));
    return (
      saved.inputs === fingerprintBuildInputs(inputs) && saved.output === fingerprintOutput(stamp)
    );
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

// Ordinary package builds do not update fixture stamps. Include all output,
// not just entry points, so a build followed by a source revert cannot reuse
// a stamp for different code. Exclude the stamp itself from its signature.
function fingerprintOutput(stamp: string): string {
  const hash = createHash("sha256");
  updateFingerprint(hash, dirname(stamp), stamp);
  return hash.digest("hex");
}

function updateFingerprint(
  hash: ReturnType<typeof createHash>,
  path: string,
  excluded?: string,
): void {
  if (path === excluded) return;
  hash.update(path);
  hash.update("\0");

  let children: string[];
  try {
    children = readdirSync(path).sort();
  } catch (error) {
    if (!isNotDirectoryError(error)) throw error;
    const file = openSync(path, "r");
    try {
      hash.update(readFileSync(file));
    } finally {
      closeSync(file);
    }
    hash.update("\0");
    return;
  }

  for (const child of children) {
    updateFingerprint(hash, join(path, child), excluded);
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
    return !isProcessAlive(owner.pid);
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

function isNotDirectoryError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOTDIR";
}
