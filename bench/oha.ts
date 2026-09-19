import { createHash } from "node:crypto";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { BenchmarkScenario, HttpBenchmarkSettings } from "./bench.js";

export const OHA_VERSION = "1.16.0";
const RELEASE_ASSETS: Readonly<Record<string, { name: string; sha256: string }>> = {
  "darwin-arm64": {
    name: "oha-macos-arm64",
    sha256: "7dea53ecb8342a7a067e1976fd0aef44ac33d9cc6b1e65c53637ffb932da63c4",
  },
  "darwin-x64": {
    name: "oha-macos-amd64",
    sha256: "5ecbfc5233e3f1d30384e142a9a8dd7ebf9d3298ab22476fabac44a8f2117e08",
  },
  "linux-arm64": {
    name: "oha-linux-arm64",
    sha256: "99a790eb8c3e0feaca974bd6b32f0f8d4426a0c5b289f39e833e5b2c7529cd39",
  },
  "linux-x64": {
    name: "oha-linux-amd64",
    sha256: "620bb9e16fb53eabc9a3fc45f88bdb41fefa3fee5c05e75892011ce320391716",
  },
};

/** Install a checksum-pinned native client inside the checkout, never globally. */
export async function prepareOha() {
  const override = Bun.env.TYPESPEX_BENCH_OHA;
  if (override === "") throw new Error("TYPESPEX_BENCH_OHA must not be empty.");
  const asset = RELEASE_ASSETS[`${process.platform}-${process.arch}`];
  if (!asset && !override) throw new Error("Unsupported oha platform; set TYPESPEX_BENCH_OHA.");
  const path = resolve(
    override ?? resolve(import.meta.dir, `../.context/bench-tools/oha-${OHA_VERSION}`),
  );
  if (!(await Bun.file(path).exists()) && !override) {
    const response = await fetch(
      `https://github.com/hatoo/oha/releases/download/v${OHA_VERSION}/${asset!.name}`,
      { signal: AbortSignal.timeout(60_000) },
    );
    if (!response.ok) throw new Error(`Downloading oha failed: HTTP ${response.status}.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== asset!.sha256) {
      throw new Error("Downloaded oha checksum did not match the pinned release.");
    }
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      await Bun.write(temporary, bytes);
      await chmod(temporary, 0o755);
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  const sha256 = createHash("sha256")
    .update(await Bun.file(path).bytes())
    .digest("hex");
  if (!override && sha256 !== asset!.sha256) throw new Error("Cached oha checksum mismatch.");
  const version = Bun.spawnSync([path, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  if (version.exitCode !== 0 || version.stdout.toString().trim() !== `oha ${OHA_VERSION}`) {
    throw new Error(`Expected oha ${OHA_VERSION}: ${version.stdout}${version.stderr}`);
  }
  return { name: "oha", version: OHA_VERSION, path, sha256, customBinary: override !== undefined };
}

export function ohaArguments(
  url: string,
  scenario: BenchmarkScenario,
  settings: HttpBenchmarkSettings,
  durationSeconds = settings.durationSeconds,
): string[] {
  const args = [
    "--no-tui",
    "--output-format",
    "json",
    "--http-version",
    "1.1",
    "--disable-compression",
    "--wait-ongoing-requests-after-deadline",
    "-z",
    `${durationSeconds}s`,
    "-c",
    String(settings.connections),
    "--worker-threads",
    String(settings.clientThreads),
    "-t",
    `${settings.timeoutSeconds}s`,
    "-m",
    scenario.method ?? "GET",
  ];
  for (const [name, value] of Object.entries(scenario.headers ?? {}))
    args.push("-H", `${name}: ${value}`);
  if (scenario.body !== undefined) args.push("-d", scenario.body);
  args.push(url);
  return args;
}

export interface OhaResult {
  readonly summary: {
    readonly successRate: number;
    readonly total: number;
    readonly slowest: number;
    readonly fastest: number;
    readonly average: number;
    readonly requestsPerSec: number;
    readonly totalData: number;
    readonly sizePerRequest: number;
    readonly sizePerSec: number;
  };
  readonly latencyPercentiles: { readonly p50: number; readonly p99: number };
  readonly statusCodeDistribution: Readonly<Record<string, number>>;
  readonly errorDistribution: Readonly<Record<string, number>>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Check the JSON boundary before trusting any of the native client's statistics. */
export function validateOhaResult(value: unknown, scenario: BenchmarkScenario): OhaResult {
  if (
    !record(value) ||
    !record(value.summary) ||
    !record(value.latencyPercentiles) ||
    !record(value.statusCodeDistribution) ||
    !record(value.errorDistribution)
  ) {
    throw new Error("oha omitted required statistics.");
  }
  const positive = ["total", "requestsPerSec", "totalData", "sizePerRequest", "sizePerSec"];
  const nonnegative = ["slowest", "fastest", "average", "successRate"];
  for (const name of [...positive, ...nonnegative]) {
    const metric = value.summary[name];
    if (
      typeof metric !== "number" ||
      !Number.isFinite(metric) ||
      metric < 0 ||
      (positive.includes(name) && metric === 0)
    )
      throw new Error(`Invalid oha ${name}: ${metric}.`);
  }
  for (const name of ["p50", "p99"]) {
    const metric = value.latencyPercentiles[name];
    if (typeof metric !== "number" || !Number.isFinite(metric) || metric < 0) {
      throw new Error(`Invalid oha latency ${name}: ${metric}.`);
    }
  }
  if (Object.keys(value.errorDistribution).length !== 0 || value.summary.successRate !== 1) {
    throw new Error(`oha reported failed requests: ${JSON.stringify(value.errorDistribution)}.`);
  }
  const entries = Object.entries(value.statusCodeDistribution);
  if (
    entries.length !== 1 ||
    entries[0]![0] !== String(scenario.expectedStatus) ||
    !Number.isSafeInteger(entries[0]![1]) ||
    (entries[0]![1] as number) <= 0
  ) {
    throw new Error(`Unexpected oha statuses: ${JSON.stringify(value.statusCodeDistribution)}.`);
  }
  const count = entries[0]![1] as number;
  const result = value as unknown as OhaResult;
  const bytes = Buffer.byteLength(scenario.expectedBody);
  if (result.summary.totalData !== count * bytes || result.summary.sizePerRequest !== bytes) {
    throw new Error("oha response-byte totals do not match the expected bodies.");
  }
  const expectedRate = count / result.summary.total;
  if (
    Math.abs(result.summary.requestsPerSec / expectedRate - 1) > 0.000001 ||
    Math.abs(result.summary.sizePerSec / (expectedRate * bytes) - 1) > 0.000001
  ) {
    throw new Error("oha rates disagree with the completed request and byte counts.");
  }
  return result;
}

let activeClient: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;

export function stopOha(): void {
  activeClient?.kill("SIGKILL");
}

export async function runOha(
  binary: string,
  url: string,
  scenario: BenchmarkScenario,
  settings: HttpBenchmarkSettings,
  probe: () => Promise<void>,
  durationSeconds = settings.durationSeconds,
) {
  const startedAt = new Date().toISOString();
  const child = Bun.spawn([binary, ...ohaArguments(url, scenario, settings, durationSeconds)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  activeClient = child;
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let finished = false;
  let bodyProbes = 0;
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      child.kill("SIGKILL");
    },
    (durationSeconds + settings.timeoutSeconds + 5) * 1000,
  );
  const sampleBodies = (async () => {
    while (!finished) {
      await probe();
      bodyProbes++;
      await Bun.sleep(100);
    }
  })();
  const exit = child.exited.finally(() => {
    finished = true;
  });
  try {
    await Promise.all([exit, sampleBodies, stdout, stderr]);
    const [output, diagnostics] = await Promise.all([stdout, stderr]);
    if (timedOut || child.exitCode !== 0) {
      throw new Error(`oha ${timedOut ? "timed out" : `exited ${child.exitCode}`}: ${diagnostics}`);
    }
    return {
      result: validateOhaResult(JSON.parse(output), scenario),
      bodyProbes,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  } finally {
    finished = true;
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.allSettled([exit, sampleBodies, stdout, stderr]);
    if (activeClient === child) activeClient = undefined;
  }
}
