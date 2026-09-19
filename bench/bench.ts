import { appendFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { prepareOha, runOha, stopOha, type OhaResult } from "./oha.js";
import { assessHeadroom, headroomReport, type HeadroomAssessment } from "./headroom.js";
import {
  balancedOrder,
  benchmarkMetadata,
  positiveIntegerSetting,
  summarize,
  type DistributionSummary,
  writeBenchmarkArtifact,
} from "./benchmark-common.js";
import { CREATED_PET, CREATE_PET_INPUT, INITIAL_PETS } from "./fixture.js";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
const BASELINE_ROOT = Bun.env.TYPESPEX_BENCH_BASELINE_ROOT;

export interface HttpBenchmarkSettings {
  readonly durationSeconds: number;
  readonly warmupSeconds: number;
  readonly trials: number;
  readonly connections: number;
  readonly clientThreads: number;
  readonly timeoutSeconds: number;
  readonly seed: string;
}

export const HTTP_SETTINGS: HttpBenchmarkSettings = Object.freeze({
  durationSeconds: positiveIntegerSetting("TYPESPEX_BENCH_DURATION", 10),
  warmupSeconds: positiveIntegerSetting("TYPESPEX_BENCH_WARMUP", 2),
  trials: positiveIntegerSetting("TYPESPEX_BENCH_TRIALS", 5),
  connections: positiveIntegerSetting("TYPESPEX_BENCH_CONNECTIONS", 500),
  clientThreads: positiveIntegerSetting("TYPESPEX_BENCH_CLIENT_THREADS", 2),
  timeoutSeconds: positiveIntegerSetting("TYPESPEX_BENCH_TIMEOUT", 10),
  seed: Bun.env.TYPESPEX_BENCH_SEED ?? "typespex-http-v1",
});

export interface BenchmarkServer {
  readonly id: string;
  readonly name: string;
  readonly port: number;
  readonly script: string;
}

export function benchmarkServers(baselineRoot?: string): readonly BenchmarkServer[] {
  if (baselineRoot === "") {
    throw new Error("TYPESPEX_BENCH_BASELINE_ROOT must not be empty.");
  }
  const servers: BenchmarkServer[] = [
    {
      id: "calibration",
      name: "Cached response control",
      port: 3462,
      script: "bench-calibration.ts",
    },
    { id: "bare-bun", name: "Bare Bun", port: 3457, script: "bench-baseline.ts" },
    { id: "hono", name: "Hono", port: 3458, script: "bench-hono.ts" },
    { id: "hono-zod", name: "Hono+Zod", port: 3459, script: "bench-hono-zod.ts" },
    { id: "typespex", name: "TypeSpex", port: 3456, script: "bench-typespex.ts" },
    { id: "elysia", name: "Elysia", port: 3461, script: "bench-elysia.ts" },
  ];
  if (baselineRoot !== undefined) {
    servers.push({
      id: "typespex-baseline",
      name: "TypeSpex baseline",
      port: 3460,
      script: resolve(REPOSITORY_ROOT, baselineRoot, "bench/bench-typespex.ts"),
    });
  }
  return servers;
}

export const SERVERS = benchmarkServers(BASELINE_ROOT);

export interface BenchmarkScenario {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly expectedStatus: number;
  readonly expectedBody: string;
}

export const SCENARIOS: readonly BenchmarkScenario[] = [
  {
    id: "list",
    name: "GET /pets?limit=10",
    path: "/pets?limit=10",
    expectedStatus: 200,
    expectedBody: JSON.stringify(INITIAL_PETS.slice(0, 10)),
  },
  {
    id: "list-unused-query",
    name: "GET /pets (29 unused query fields)",
    path: `/pets?limit=10&${Array.from({ length: 29 }, (_, index) => `extra${index}=${index}`).join("&")}`,
    expectedStatus: 200,
    expectedBody: JSON.stringify(INITIAL_PETS.slice(0, 10)),
  },
  {
    id: "read",
    name: "GET /pets/:id (success)",
    path: "/pets/pet-0",
    expectedStatus: 200,
    expectedBody: JSON.stringify(INITIAL_PETS[0]!),
  },
  {
    id: "not-found",
    name: "GET /pets/:id (404)",
    path: "/pets/nonexistent",
    expectedStatus: 404,
    expectedBody: JSON.stringify({
      code: "NOT_FOUND",
      message: "Pet nonexistent not found",
    }),
  },
  {
    id: "create",
    name: "POST /pets (create)",
    path: "/pets",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(CREATE_PET_INPUT),
    expectedStatus: 200,
    expectedBody: JSON.stringify(CREATED_PET),
  },
  {
    id: "create-formatted",
    name: "POST /pets (formatted JSON)",
    path: "/pets",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(CREATE_PET_INPUT, null, 2),
    expectedStatus: 200,
    expectedBody: JSON.stringify(CREATED_PET),
  },
] as const;

export type FetchRequest = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function fetchWithTimeout(
  timeoutMilliseconds: number,
  fetchRequest: FetchRequest = fetch,
): FetchRequest {
  if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    throw new Error("Fetch timeout must be a positive number of milliseconds.");
  }
  return (input, init) => {
    // Validation requests sit idle throughout warmup and measurement. Do not
    // reuse a connection that the server may close during that interval.
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set("connection", "close");
    return fetchRequest(input, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
  };
}

export async function validateScenario(
  url: string,
  scenario: BenchmarkScenario,
  phase = "preflight",
  fetchRequest: FetchRequest = fetch,
): Promise<void> {
  const response = await fetchRequest(url, {
    method: scenario.method ?? "GET",
    headers: scenario.headers,
    body: scenario.body,
  });
  const body = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const problems: string[] = [];
  if (response.status !== scenario.expectedStatus) {
    problems.push(`status ${response.status}, expected ${scenario.expectedStatus}`);
  }
  if (!contentType.toLowerCase().startsWith("application/json")) {
    problems.push(`content-type ${JSON.stringify(contentType)}, expected application/json`);
  }
  if (body !== scenario.expectedBody) {
    problems.push(
      `body ${JSON.stringify(body)}, expected ${JSON.stringify(scenario.expectedBody)}`,
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `${scenario.name} ${phase} failed for ${scenario.method ?? "GET"} ${url}: ${problems.join("; ")}.`,
    );
  }
}

export interface HttpSample {
  readonly trial: number;
  readonly sequence: number;
  readonly serverId: string;
  readonly server: string;
  readonly scenarioId: string;
  readonly scenario: string;
  readonly requestsPerSecond: number;
  readonly requestsTotal: number;
  readonly latencyAverageMs: number;
  readonly latencyP50Ms: number;
  readonly latencyP99Ms: number;
  readonly latencyMaxMs: number;
  readonly throughputAverageBytesPerSecond: number;
  readonly durationSeconds: number;
  readonly bodyProbes: number;
  readonly raw: OhaResult;
  readonly statusCodes: Readonly<Record<string, number>>;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface HttpAggregate {
  readonly scenarioId: string;
  readonly scenario: string;
  readonly serverId: string;
  readonly server: string;
  readonly requestsPerSecond: DistributionSummary;
  readonly latencyP50Ms: DistributionSummary;
  readonly latencyP99Ms: DistributionSummary;
  readonly throughputRatioToBare: DistributionSummary;
  readonly throughputRatioToBaseline?: DistributionSummary;
}

export function aggregateSamples(
  samples: readonly HttpSample[],
  servers: readonly BenchmarkServer[] = SERVERS,
): readonly HttpAggregate[] {
  const output: HttpAggregate[] = [];
  for (const scenario of SCENARIOS) {
    const baselineByTrial = new Map(
      samples
        .filter((sample) => sample.scenarioId === scenario.id && sample.serverId === "bare-bun")
        .map((sample) => [sample.trial, sample.requestsPerSecond]),
    );
    const previousByTrial = new Map(
      samples
        .filter(
          (sample) => sample.scenarioId === scenario.id && sample.serverId === "typespex-baseline",
        )
        .map((sample) => [sample.trial, sample.requestsPerSecond]),
    );
    for (const server of servers) {
      if (server.id === "calibration") continue;
      const group = samples.filter(
        (sample) => sample.scenarioId === scenario.id && sample.serverId === server.id,
      );
      if (group.length === 0) continue;
      const ratios = group.map((sample) => {
        const baseline = baselineByTrial.get(sample.trial);
        if (baseline === undefined) {
          throw new Error(`Missing Bare Bun sample for ${scenario.id}, trial ${sample.trial}.`);
        }
        return sample.requestsPerSecond / baseline;
      });
      output.push({
        scenarioId: scenario.id,
        scenario: scenario.name,
        serverId: server.id,
        server: server.name,
        requestsPerSecond: summarize(group.map((sample) => sample.requestsPerSecond)),
        latencyP50Ms: summarize(group.map((sample) => sample.latencyP50Ms)),
        latencyP99Ms: summarize(group.map((sample) => sample.latencyP99Ms)),
        throughputRatioToBare: summarize(ratios),
        throughputRatioToBaseline:
          previousByTrial.size === 0
            ? undefined
            : summarize(
                group.map((sample) => {
                  const previous = previousByTrial.get(sample.trial);
                  if (previous === undefined) {
                    throw new Error(
                      `Missing TypeSpex baseline sample for ${scenario.id}, trial ${sample.trial}.`,
                    );
                  }
                  return sample.requestsPerSecond / previous;
                }),
              ),
      });
    }
  }
  return output;
}

interface ScheduleCell {
  readonly trial: number;
  readonly sequence: number;
  readonly serverId: string;
  readonly scenarioId: string;
}

export function createSchedule(
  settings: HttpBenchmarkSettings = HTTP_SETTINGS,
  servers: readonly BenchmarkServer[] = SERVERS,
): readonly ScheduleCell[] {
  const schedule: ScheduleCell[] = [];
  for (let trial = 1; trial <= settings.trials; trial++) {
    const scenarios = balancedOrder(SCENARIOS, trial - 1, `${settings.seed}:scenarios`);
    for (const scenario of scenarios) {
      const scenarioIndex = SCENARIOS.findIndex((candidate) => candidate.id === scenario.id);
      const orderedServers = balancedOrder(
        servers,
        trial - 1 + scenarioIndex,
        `${settings.seed}:servers:${scenario.id}`,
      );
      for (const server of orderedServers) {
        schedule.push({
          trial,
          sequence: schedule.length + 1,
          serverId: server.id,
          scenarioId: scenario.id,
        });
      }
    }
  }
  return schedule;
}

function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolveOpen) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveOpen(open);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

type ServerProcess = Bun.Subprocess<"ignore", "pipe", "pipe">;

interface RunningServer {
  readonly child: ServerProcess;
  readonly stdout: Promise<string>;
  readonly stderr: Promise<string>;
}

let activeChild: ServerProcess | undefined;

async function stopServer(running: RunningServer): Promise<void> {
  if (running.child.exitCode === null) running.child.kill("SIGTERM");
  const exited = await Promise.race([
    running.child.exited.then(() => true),
    Bun.sleep(2_000).then(() => false),
  ]);
  if (!exited && running.child.exitCode === null) {
    running.child.kill("SIGKILL");
    await running.child.exited;
  }
  await Promise.all([running.stdout, running.stderr]);
  if (activeChild === running.child) activeChild = undefined;
}

async function startServer(
  server: BenchmarkServer,
  scenario: BenchmarkScenario,
): Promise<RunningServer> {
  if (await portIsOpen(server.port)) {
    throw new Error(
      `Port ${server.port} is already in use; refusing to benchmark another process.`,
    );
  }
  const child = Bun.spawn([process.execPath, "run", server.script], {
    cwd: import.meta.dir,
    env: {
      ...Bun.env,
      TYPESPEX_BENCH_PORT: String(server.port),
      TYPESPEX_BENCH_CONTROL_BODY: scenario.expectedBody,
      TYPESPEX_BENCH_CONTROL_STATUS: String(scenario.expectedStatus),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  activeChild = child;
  const running: RunningServer = {
    child,
    stdout: new Response(child.stdout).text(),
    stderr: new Response(child.stderr).text(),
  };

  const deadline = Date.now() + 10_000;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        const [stdout, stderr] = await Promise.all([running.stdout, running.stderr]);
        throw new Error(
          `${server.name} exited during startup with code ${child.exitCode}.\n${stdout}${stderr}`.trim(),
        );
      }
      try {
        const response = await fetch(
          `http://127.0.0.1:${server.port}${server.id === "calibration" ? "/__bench_health" : "/pets?limit=1"}`,
          {
            signal: AbortSignal.timeout(250),
          },
        );
        await response.arrayBuffer();
        if (response.status === 200 && child.exitCode === null) return running;
      } catch {
        // The process may still be starting.
      }
      await Bun.sleep(50);
    }
    throw new Error(`${server.name} did not become healthy on port ${server.port} within 10s.`);
  } catch (error) {
    await stopServer(running);
    throw error;
  }
}

function extractSample(
  trial: number,
  sequence: number,
  server: BenchmarkServer,
  scenario: BenchmarkScenario,
  measured: Awaited<ReturnType<typeof runOha>>,
): HttpSample {
  const { result, bodyProbes, startedAt, finishedAt } = measured;
  return {
    trial,
    sequence,
    serverId: server.id,
    server: server.name,
    scenarioId: scenario.id,
    scenario: scenario.name,
    requestsPerSecond: result.summary.requestsPerSec,
    requestsTotal: result.statusCodeDistribution[String(scenario.expectedStatus)]!,
    latencyAverageMs: result.summary.average * 1000,
    latencyP50Ms: result.latencyPercentiles.p50 * 1000,
    latencyP99Ms: result.latencyPercentiles.p99 * 1000,
    latencyMaxMs: result.summary.slowest * 1000,
    throughputAverageBytesPerSecond: result.summary.sizePerSec,
    durationSeconds: result.summary.total,
    statusCodes: result.statusCodeDistribution,
    bodyProbes,
    raw: result,
    startedAt,
    finishedAt,
  };
}

function formatRate(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function printSummary(
  aggregates: readonly HttpAggregate[],
  headroom: readonly HeadroomAssessment[],
): void {
  const nameWidth = Math.max(12, ...aggregates.map((row) => row.server.length));
  console.log("\nMedian of trials; variability is median absolute deviation (MAD).\n");
  console.log("oha latencies are converted from seconds to milliseconds.\n");
  for (const scenario of SCENARIOS) {
    const calibration = headroom.find((row) => row.scenarioId === scenario.id)!;
    console.log(
      `${scenario.name} — ${calibration.verified ? "headroom verified" : "UNVERIFIED: headroom not demonstrated"}`,
    );
    console.log(
      `  Control / fastest implementation: ${calibration.ratioToFastest?.median.toFixed(3) ?? "n/a"}x median, ${calibration.ratioToFastest?.min.toFixed(3) ?? "n/a"}x minimum; require ${calibration.requiredRatio}x in every trial.`,
    );
    console.log(
      `  ${"Server".padEnd(nameWidth)} req/s median ± MAD       observed range       p50 ms   p99 ms   vs Bare`,
    );
    for (const row of aggregates.filter((candidate) => candidate.scenarioId === scenario.id)) {
      const rate = `${formatRate(row.requestsPerSecond.median)} ± ${formatRate(row.requestsPerSecond.mad)}`;
      const range = `${formatRate(row.requestsPerSecond.min)}–${formatRate(row.requestsPerSecond.max)}`;
      const ratio = calibration.verified
        ? `${row.throughputRatioToBare.median.toFixed(3)}x`
        : "unverified";
      console.log(
        `  ${row.server.padEnd(nameWidth)} ${rate.padStart(20)} ${range.padStart(20)} ${row.latencyP50Ms.median.toFixed(2).padStart(8)} ${row.latencyP99Ms.median.toFixed(2).padStart(8)} ${ratio.padStart(9)}`,
      );
    }
    const current = aggregates.find(
      (row) => row.scenarioId === scenario.id && row.serverId === "typespex",
    );
    if (calibration.verified && current?.throughputRatioToBaseline) {
      console.log(
        `  TypeSpex vs baseline: ${current.throughputRatioToBaseline.median.toFixed(3)}x median paired throughput`,
      );
    }
    console.log("");
  }
}

async function writeArtifact(
  complete: boolean,
  metadata: Awaited<ReturnType<typeof benchmarkMetadata>>,
  schedule: readonly ScheduleCell[],
  samples: readonly HttpSample[],
  artifactPath?: string,
  error?: unknown,
): Promise<string> {
  const headroom = assessHeadroom(samples, schedule);
  const aggregates =
    samples.length === schedule.length
      ? aggregateSamples(samples).map((row) => {
          const verified =
            complete &&
            headroom.find((assessment) => assessment.scenarioId === row.scenarioId)?.verified ===
              true;
          return {
            ...row,
            comparisonsVerified: verified,
            throughputRatioToBare: verified ? row.throughputRatioToBare : undefined,
            throughputRatioToBaseline: verified ? row.throughputRatioToBaseline : undefined,
          };
        })
      : [];
  return writeBenchmarkArtifact(
    "http",
    {
      schemaVersion: 2,
      kind: "http",
      complete,
      metadata,
      settings: HTTP_SETTINGS,
      schedule,
      samples,
      aggregates,
      comparisonValidity: {
        verified: complete && headroom.length > 0 && headroom.every((row) => row.verified),
        scenarios: headroom,
        bodyValidation:
          "Exact bodies before, during (~10 probes/s), and after load; all timed statuses and total response bytes checked.",
      },
      error:
        error === undefined
          ? undefined
          : error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : { message: String(error) },
    },
    REPOSITORY_ROOT,
    artifactPath,
  );
}

async function main(): Promise<void> {
  for (const server of SERVERS) {
    if (await portIsOpen(server.port)) {
      throw new Error(
        `Port ${server.port} is already in use; stop that process before benchmarking.`,
      );
    }
  }

  for (const setting of ["TYPESPEX_BENCH_PIPELINING", "TYPESPEX_BENCH_OVERALL_RATE"]) {
    if (Bun.env[setting] !== undefined)
      throw new Error(`${setting} is unsupported by the calibrated oha throughput benchmark.`);
  }
  const client = await prepareOha();
  const metadata = {
    loadGenerator: client,
    ...(await benchmarkMetadata(REPOSITORY_ROOT)),
    baseline:
      BASELINE_ROOT === undefined
        ? undefined
        : await benchmarkMetadata(resolve(REPOSITORY_ROOT, BASELINE_ROOT)),
  };
  const schedule = createSchedule();
  const samples: HttpSample[] = [];
  const artifactPath = await writeArtifact(false, metadata, schedule, samples);
  const validationFetch = fetchWithTimeout(HTTP_SETTINGS.timeoutSeconds * 1_000);
  const estimatedSeconds =
    schedule.length * (HTTP_SETTINGS.durationSeconds + HTTP_SETTINGS.warmupSeconds);
  console.log(
    `HTTP benchmark: ${HTTP_SETTINGS.trials} trials, ${HTTP_SETTINGS.connections} connections, ` +
      `oha ${client.version} (${HTTP_SETTINGS.clientThreads} threads), ${HTTP_SETTINGS.warmupSeconds}s warmup + ` +
      `${HTTP_SETTINGS.durationSeconds}s measurement per cell.`,
  );
  console.log(
    `Fresh process per cell; ${schedule.length} cells; about ${(estimatedSeconds / 60).toFixed(1)} minutes plus startup.`,
  );
  console.log(`Order seed: ${HTTP_SETTINGS.seed}\n`);

  try {
    for (const cell of schedule) {
      const server = SERVERS.find((candidate) => candidate.id === cell.serverId)!;
      const scenario = SCENARIOS.find((candidate) => candidate.id === cell.scenarioId)!;
      const url = `http://127.0.0.1:${server.port}${scenario.path}`;
      console.log(
        `[${cell.sequence}/${schedule.length}] trial ${cell.trial}: ${server.name} — ${scenario.name}`,
      );
      const running = await startServer(server, scenario);
      try {
        await validateScenario(url, scenario, "preflight", validationFetch);
        const probe = () => validateScenario(url, scenario, "during load", validationFetch);
        await runOha(client.path, url, scenario, HTTP_SETTINGS, probe, HTTP_SETTINGS.warmupSeconds);
        const measured = await runOha(client.path, url, scenario, HTTP_SETTINGS, probe);
        await validateScenario(url, scenario, "postflight", validationFetch);
        const sample = extractSample(cell.trial, cell.sequence, server, scenario, measured);
        samples.push(sample);
        console.log(
          `  ${formatRate(sample.requestsPerSecond)} req/s, p50 ${sample.latencyP50Ms.toFixed(2)} ms, p99 ${sample.latencyP99Ms.toFixed(2)} ms`,
        );
      } finally {
        await stopServer(running);
      }
      // Checkpoint between cells, outside the measured interval. A cancelled
      // run can still upload its last complete measurements.
      await writeArtifact(false, metadata, schedule, samples, artifactPath);
    }
  } catch (error) {
    await writeArtifact(false, metadata, schedule, samples, artifactPath, error);
    console.error(`\nBenchmark failed. Partial diagnostic artifact: ${artifactPath}`);
    throw error;
  }

  const aggregates = aggregateSamples(samples);
  const headroom = assessHeadroom(samples, schedule);
  await writeArtifact(true, metadata, schedule, samples, artifactPath);
  printSummary(aggregates, headroom);
  if (Bun.env.GITHUB_STEP_SUMMARY) {
    await appendFile(Bun.env.GITHUB_STEP_SUMMARY, headroomReport(headroom));
    const unverified = headroom.filter((row) => !row.verified).map((row) => row.scenarioId);
    if (unverified.length > 0)
      console.warn(
        `::warning title=Unverified HTTP comparisons::Headroom not demonstrated for ${unverified.join(", ")}; comparative ratios withheld.`,
      );
  }
  console.log(`Raw trials, schedule, settings, and machine metadata: ${artifactPath}`);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopOha();
    activeChild?.kill(signal);
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  }
}
