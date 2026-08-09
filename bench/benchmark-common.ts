import { mkdir } from "node:fs/promises";
import { arch, cpus, freemem, hostname, platform, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";

export interface DistributionSummary {
  readonly median: number;
  readonly mad: number;
  readonly min: number;
  readonly max: number;
}

export function positiveIntegerSetting(name: string, fallback: number): number {
  const raw = Bun.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

export function optionalPositiveIntegerSetting(name: string): number | undefined {
  const raw = Bun.env[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer when set.`);
  }
  return value;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("Cannot calculate a median without values.");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

export function summarize(values: readonly number[]): DistributionSummary {
  const center = median(values);
  return {
    median: center,
    mad: median(values.map((value) => Math.abs(value - center))),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** A deterministic base shuffle followed by rotation, suitable for balancing trial order. */
export function balancedOrder<T>(values: readonly T[], trial: number, seed: string): readonly T[] {
  if (values.length === 0) return [];
  const shuffled = [...values];
  let state = hashSeed(seed) || 0x9e3779b9;
  for (let index = shuffled.length - 1; index > 0; index--) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const swapWith = (state >>> 0) % (index + 1);
    [shuffled[index], shuffled[swapWith]] = [shuffled[swapWith]!, shuffled[index]!];
  }
  const offset = ((trial % shuffled.length) + shuffled.length) % shuffled.length;
  return [...shuffled.slice(offset), ...shuffled.slice(0, offset)];
}

function gitOutput(repositoryRoot: string, args: readonly string[]): string | undefined {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return undefined;
  return result.stdout.toString().trim();
}

export async function installedPackageVersion(
  repositoryRoot: string,
  packageName: string,
): Promise<string | undefined> {
  const packageDirectories = [
    resolve(repositoryRoot, "bench/node_modules"),
    resolve(repositoryRoot, "node_modules"),
  ];
  for (const packageDirectory of packageDirectories) {
    const manifest = Bun.file(resolve(packageDirectory, packageName, "package.json"));
    if (!(await manifest.exists())) continue;
    const value = (await manifest.json()) as { version?: string };
    return value.version;
  }
  return undefined;
}

export async function benchmarkMetadata(repositoryRoot: string) {
  const status = gitOutput(repositoryRoot, ["status", "--porcelain"]);
  const cpuModels = [...new Set(cpus().map((cpu) => cpu.model))];

  return {
    recordedAt: new Date().toISOString(),
    git: {
      commit: gitOutput(repositoryRoot, ["rev-parse", "HEAD"]),
      branch: gitOutput(repositoryRoot, ["branch", "--show-current"]),
      dirty: status === undefined ? undefined : status.length > 0,
    },
    runtime: { name: "Bun", version: Bun.version },
    system: {
      platform: platform(),
      release: release(),
      architecture: arch(),
      hostname: hostname(),
      logicalCpuCount: cpus().length,
      cpuModels,
      totalMemoryBytes: totalmem(),
      freeMemoryBytesAtStart: freemem(),
    },
    dependencies: {
      autocannon: await installedPackageVersion(repositoryRoot, "autocannon"),
      hono: await installedPackageVersion(repositoryRoot, "hono"),
      honoZodValidator: await installedPackageVersion(repositoryRoot, "@hono/zod-validator"),
      zod: await installedPackageVersion(repositoryRoot, "zod"),
      tinybench: await installedPackageVersion(repositoryRoot, "tinybench"),
    },
  };
}

export async function writeBenchmarkArtifact(
  kind: string,
  value: unknown,
  repositoryRoot = resolve(import.meta.dir, ".."),
): Promise<string> {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const configuredPath = Bun.env.TYPESPEX_BENCH_OUTPUT;
  const outputPath = resolve(
    repositoryRoot,
    configuredPath ?? `.context/bench-results/${kind}-${timestamp}.json`,
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, `${JSON.stringify(value, null, 2)}\n`);
  return outputPath;
}
