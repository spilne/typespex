import { createConnection } from "node:net";
import { resolve } from "node:path";
import autocannon from "autocannon";
import {
  balancedOrder,
  benchmarkMetadata,
  optionalPositiveIntegerSetting,
  positiveIntegerSetting,
  summarize,
  type DistributionSummary,
  writeBenchmarkArtifact,
} from "./benchmark-common.js";
import { CREATED_PET, CREATE_PET_INPUT, INITIAL_PETS } from "./fixture.js";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..");

export interface HttpBenchmarkSettings {
  readonly durationSeconds: number;
  readonly warmupSeconds: number;
  readonly trials: number;
  readonly connections: number;
  readonly pipelining: number;
  readonly timeoutSeconds: number;
  readonly overallRate?: number;
  readonly seed: string;
}

export const HTTP_SETTINGS: HttpBenchmarkSettings = Object.freeze({
  durationSeconds: positiveIntegerSetting("TYPESPEX_BENCH_DURATION", 10),
  warmupSeconds: positiveIntegerSetting("TYPESPEX_BENCH_WARMUP", 2),
  trials: positiveIntegerSetting("TYPESPEX_BENCH_TRIALS", 5),
  connections: positiveIntegerSetting("TYPESPEX_BENCH_CONNECTIONS", 50),
  pipelining: positiveIntegerSetting("TYPESPEX_BENCH_PIPELINING", 1),
  timeoutSeconds: positiveIntegerSetting("TYPESPEX_BENCH_TIMEOUT", 10),
  overallRate: optionalPositiveIntegerSetting("TYPESPEX_BENCH_OVERALL_RATE"),
  seed: Bun.env.TYPESPEX_BENCH_SEED ?? "typespex-http-v1",
});

export interface BenchmarkServer {
  readonly id: string;
  readonly name: string;
  readonly port: number;
  readonly script: string;
}

export const SERVERS: readonly BenchmarkServer[] = [
  { id: "bare-bun", name: "Bare Bun", port: 3457, script: "bench-baseline.ts" },
  { id: "hono", name: "Hono", port: 3458, script: "bench-hono.ts" },
  { id: "hono-zod", name: "Hono+Zod", port: 3459, script: "bench-hono-zod.ts" },
  { id: "typespex", name: "TypeSpex", port: 3456, script: "bench-typespex.ts" },
] as const;

export interface BenchmarkScenario {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly method?: autocannon.Request["method"];
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
] as const;

export type FetchRequest = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function fetchWithTimeout(
  timeoutMilliseconds: number,
  fetchRequest: FetchRequest = fetch,
): FetchRequest {
  if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    throw new Error("Fetch timeout must be a positive number of milliseconds.");
  }
  return (input, init) =>
    fetchRequest(input, {
      ...init,
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
}

export function autocannonOptions(
  url: string,
  scenario: BenchmarkScenario,
  duration = HTTP_SETTINGS.durationSeconds,
): autocannon.Options {
  return {
    url,
    duration,
    connections: HTTP_SETTINGS.connections,
    pipelining: HTTP_SETTINGS.pipelining,
    timeout: HTTP_SETTINGS.timeoutSeconds,
    bailout: 1,
    overallRate: HTTP_SETTINGS.overallRate,
    method: scenario.method ?? "GET",
    headers: scenario.headers,
    body: scenario.body,
    expectBody: scenario.expectedBody,
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

export type ValidatableAutocannonResult = Pick<
  autocannon.Result,
  "duration" | "errors" | "timeouts" | "mismatches" | "resets" | "non2xx" | "statusCodeStats"
> & {
  readonly requests: Pick<autocannon.Result["requests"], "average" | "sent" | "total">;
  readonly latency: Pick<autocannon.Result["latency"], "average" | "max" | "p50" | "p99">;
  readonly throughput: Pick<autocannon.Result["throughput"], "average">;
};

export function validateAutocannonResult(
  result: ValidatableAutocannonResult,
  scenario: BenchmarkScenario,
  phase: "warmup" | "measurement",
): void {
  const problems: string[] = [];
  const completed = result.requests.total;
  if (completed <= 0) problems.push("completed no requests");
  if (result.requests.sent < completed) {
    problems.push(`sent ${result.requests.sent} requests but completed ${completed}`);
  }
  const positiveMetrics = [
    ["duration", result.duration],
    ["request rate", result.requests.average],
    ["throughput", result.throughput.average],
  ] as const;
  for (const [name, value] of positiveMetrics) {
    if (!Number.isFinite(value) || value <= 0) problems.push(`${name} was ${value}`);
  }
  const latencyMetrics = [
    ["average latency", result.latency.average],
    ["p50 latency", result.latency.p50],
    ["p99 latency", result.latency.p99],
    ["maximum latency", result.latency.max],
  ] as const;
  for (const [name, value] of latencyMetrics) {
    if (!Number.isFinite(value) || value < 0) problems.push(`${name} was ${value}`);
  }
  if (result.errors !== 0) problems.push(`${result.errors} connection errors`);
  if (result.timeouts !== 0) problems.push(`${result.timeouts} timeouts`);
  if (result.mismatches !== 0) problems.push(`${result.mismatches} response-body mismatches`);
  if (result.resets !== 0) problems.push(`${result.resets} pipeline resets`);

  const statusEntries = Object.entries(result.statusCodeStats ?? {}).map(
    ([status, stats]) => [Number(status), stats.count ?? 0] as const,
  );
  if (result.statusCodeStats === undefined) {
    problems.push("autocannon did not provide exact status-code counts");
  } else {
    const expectedCount =
      statusEntries.find(([status]) => status === scenario.expectedStatus)?.[1] ?? 0;
    if (expectedCount !== completed) {
      problems.push(
        `${expectedCount}/${completed} responses had expected status ${scenario.expectedStatus}`,
      );
    }
    const unexpected = statusEntries.filter(
      ([status, count]) => status !== scenario.expectedStatus && count > 0,
    );
    if (unexpected.length > 0) {
      problems.push(
        `unexpected statuses ${unexpected.map(([status, count]) => `${status}:${count}`).join(", ")}`,
      );
    }
  }

  const expectedNon2xx =
    scenario.expectedStatus >= 200 && scenario.expectedStatus < 300 ? 0 : completed;
  if (result.non2xx !== expectedNon2xx) {
    problems.push(`${result.non2xx} non-2xx responses, expected ${expectedNon2xx}`);
  }
  if (problems.length > 0) {
    throw new Error(`${scenario.name} ${phase} was invalid: ${problems.join("; ")}.`);
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
  readonly requestsSent: number;
  readonly latencyAverageMs: number;
  readonly latencyP50Ms: number;
  readonly latencyP99Ms: number;
  readonly latencyMaxMs: number;
  readonly throughputAverageBytesPerSecond: number;
  readonly durationSeconds: number;
  readonly errors: number;
  readonly timeouts: number;
  readonly mismatches: number;
  readonly resets: number;
  readonly non2xx: number;
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
}

export function aggregateSamples(samples: readonly HttpSample[]): readonly HttpAggregate[] {
  const output: HttpAggregate[] = [];
  for (const scenario of SCENARIOS) {
    const baselineByTrial = new Map(
      samples
        .filter((sample) => sample.scenarioId === scenario.id && sample.serverId === "bare-bun")
        .map((sample) => [sample.trial, sample.requestsPerSecond]),
    );
    for (const server of SERVERS) {
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
): readonly ScheduleCell[] {
  const schedule: ScheduleCell[] = [];
  for (let trial = 1; trial <= settings.trials; trial++) {
    const scenarios = balancedOrder(SCENARIOS, trial - 1, `${settings.seed}:scenarios`);
    for (const scenario of scenarios) {
      const scenarioIndex = SCENARIOS.findIndex((candidate) => candidate.id === scenario.id);
      const servers = balancedOrder(
        SERVERS,
        trial - 1 + scenarioIndex,
        `${settings.seed}:servers:${scenario.id}`,
      );
      for (const server of servers) {
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

function runAutocannon(options: autocannon.Options): Promise<autocannon.Result> {
  return new Promise((resolveResult, rejectResult) => {
    autocannon(options, (error, result) => {
      if (error) rejectResult(error);
      else resolveResult(result);
    });
  });
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

async function startServer(server: BenchmarkServer): Promise<RunningServer> {
  if (await portIsOpen(server.port)) {
    throw new Error(
      `Port ${server.port} is already in use; refusing to benchmark another process.`,
    );
  }
  const child = Bun.spawn([process.execPath, "run", server.script], {
    cwd: import.meta.dir,
    env: { ...Bun.env, TYPESPEX_BENCH_PORT: String(server.port) },
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
        const response = await fetch(`http://127.0.0.1:${server.port}/pets?limit=1`, {
          signal: AbortSignal.timeout(250),
        });
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
  result: autocannon.Result,
): HttpSample {
  return {
    trial,
    sequence,
    serverId: server.id,
    server: server.name,
    scenarioId: scenario.id,
    scenario: scenario.name,
    requestsPerSecond: result.requests.average,
    requestsTotal: result.requests.total,
    requestsSent: result.requests.sent,
    latencyAverageMs: result.latency.average,
    latencyP50Ms: result.latency.p50,
    latencyP99Ms: result.latency.p99,
    latencyMaxMs: result.latency.max,
    throughputAverageBytesPerSecond: result.throughput.average,
    durationSeconds: result.duration,
    errors: result.errors,
    timeouts: result.timeouts,
    mismatches: result.mismatches,
    resets: result.resets,
    non2xx: result.non2xx,
    statusCodes: Object.fromEntries(
      Object.entries(result.statusCodeStats ?? {}).map(([status, stats]) => [
        status,
        stats.count ?? 0,
      ]),
    ),
    startedAt: result.start.toISOString(),
    finishedAt: result.finish.toISOString(),
  };
}

function formatRate(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function printSummary(aggregates: readonly HttpAggregate[]): void {
  console.log("\nMedian of trials; variability is median absolute deviation (MAD).\n");
  console.log("Autocannon latency percentiles use whole-millisecond buckets; 0 ms means <1 ms.\n");
  for (const scenario of SCENARIOS) {
    console.log(scenario.name);
    console.log(
      "  Server       req/s median ± MAD       observed range       p50 ms   p99 ms   vs Bare",
    );
    for (const row of aggregates.filter((candidate) => candidate.scenarioId === scenario.id)) {
      const rate = `${formatRate(row.requestsPerSecond.median)} ± ${formatRate(row.requestsPerSecond.mad)}`;
      const range = `${formatRate(row.requestsPerSecond.min)}–${formatRate(row.requestsPerSecond.max)}`;
      const ratio = `${row.throughputRatioToBare.median.toFixed(3)}x`;
      console.log(
        `  ${row.server.padEnd(12)} ${rate.padStart(20)} ${range.padStart(20)} ${row.latencyP50Ms.median.toFixed(2).padStart(8)} ${row.latencyP99Ms.median.toFixed(2).padStart(8)} ${ratio.padStart(9)}`,
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
  error?: unknown,
): Promise<string> {
  const aggregates = samples.length === schedule.length ? aggregateSamples(samples) : [];
  return writeBenchmarkArtifact("http", {
    schemaVersion: 1,
    kind: "http",
    complete,
    metadata,
    settings: HTTP_SETTINGS,
    schedule,
    samples,
    aggregates,
    error:
      error === undefined
        ? undefined
        : error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { message: String(error) },
  });
}

async function main(): Promise<void> {
  for (const server of SERVERS) {
    if (await portIsOpen(server.port)) {
      throw new Error(
        `Port ${server.port} is already in use; stop that process before benchmarking.`,
      );
    }
  }

  const metadata = await benchmarkMetadata(REPOSITORY_ROOT);
  const schedule = createSchedule();
  const samples: HttpSample[] = [];
  const validationFetch = fetchWithTimeout(HTTP_SETTINGS.timeoutSeconds * 1_000);
  const estimatedSeconds =
    schedule.length * (HTTP_SETTINGS.durationSeconds + HTTP_SETTINGS.warmupSeconds);
  console.log(
    `HTTP benchmark: ${HTTP_SETTINGS.trials} trials, ${HTTP_SETTINGS.connections} connections, ` +
      `pipelining ${HTTP_SETTINGS.pipelining}, ${HTTP_SETTINGS.warmupSeconds}s warmup + ` +
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
      const running = await startServer(server);
      try {
        await validateScenario(url, scenario, "preflight", validationFetch);
        const warmup = await runAutocannon(
          autocannonOptions(url, scenario, HTTP_SETTINGS.warmupSeconds),
        );
        validateAutocannonResult(warmup, scenario, "warmup");
        const measured = await runAutocannon(autocannonOptions(url, scenario));
        validateAutocannonResult(measured, scenario, "measurement");
        await validateScenario(url, scenario, "postflight", validationFetch);
        const sample = extractSample(cell.trial, cell.sequence, server, scenario, measured);
        samples.push(sample);
        console.log(
          `  ${formatRate(sample.requestsPerSecond)} req/s, p50 ${sample.latencyP50Ms.toFixed(2)} ms, p99 ${sample.latencyP99Ms.toFixed(2)} ms`,
        );
      } finally {
        await stopServer(running);
      }
    }
  } catch (error) {
    const artifactPath = await writeArtifact(false, metadata, schedule, samples, error);
    console.error(`\nBenchmark failed. Partial diagnostic artifact: ${artifactPath}`);
    throw error;
  }

  const aggregates = aggregateSamples(samples);
  printSummary(aggregates);
  const artifactPath = await writeArtifact(true, metadata, schedule, samples);
  console.log(`Raw trials, schedule, settings, and machine metadata: ${artifactPath}`);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
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
