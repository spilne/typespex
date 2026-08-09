import { resolve } from "node:path";
import {
  createRadixMatcher,
  createRegexMatcher,
  type RouteMatcher,
  type RouteMatcherInput,
} from "@typespex/runtime";
import { Bench, mToNs, type Task } from "tinybench";
import {
  benchmarkMetadata,
  positiveIntegerSetting,
  summarize,
  type DistributionSummary,
  writeBenchmarkArtifact,
} from "./benchmark-common.js";

type MatcherName = "Radix" | "Regex";

export interface MatcherRequest {
  readonly method: string;
  readonly path: string;
  readonly expectedRoute: string | null;
  readonly expectedPathParams: Readonly<Record<string, string>>;
}

export interface MatcherSuite {
  readonly routeCount: number;
  readonly routes: readonly RouteMatcherInput<string>[];
  readonly validationRequests: readonly MatcherRequest[];
  readonly requests: readonly MatcherRequest[];
}

function routeSizesSetting(): readonly number[] {
  const raw = Bun.env.TYPESPEX_MATCHER_ROUTE_SIZES;
  const values = raw === undefined ? [16, 64, 256, 1024] : raw.split(",").map(Number);
  if (
    values.length === 0 ||
    values.some((value) => !Number.isSafeInteger(value) || value < 4 || value % 4 !== 0) ||
    new Set(values).size !== values.length
  ) {
    throw new Error(
      "TYPESPEX_MATCHER_ROUTE_SIZES must be a comma-separated list of unique positive multiples of four.",
    );
  }
  return values;
}

export const MATCHER_SETTINGS = Object.freeze({
  routeSizes: routeSizesSetting(),
  rounds: positiveIntegerSetting("TYPESPEX_MATCHER_ROUNDS", 7),
  timeMilliseconds: positiveIntegerSetting("TYPESPEX_MATCHER_TIME", 500),
  warmupMilliseconds: positiveIntegerSetting("TYPESPEX_MATCHER_WARMUP", 250),
  batchSize: positiveIntegerSetting("TYPESPEX_MATCHER_BATCH", 256),
});

export function buildMatcherSuite(routeCount: number): MatcherSuite {
  if (!Number.isSafeInteger(routeCount) || routeCount < 4 || routeCount % 4 !== 0) {
    throw new Error("Matcher route counts must be positive multiples of four.");
  }
  const resources = routeCount / 4;
  const routes: RouteMatcherInput<string>[] = [];
  const validationRequests: MatcherRequest[] = [];
  for (let index = 0; index < resources; index++) {
    const base = `/catalog/resource-${index}`;
    routes.push(
      { method: "GET", path: base, route: `resource-${index}.list` },
      { method: "POST", path: base, route: `resource-${index}.create` },
      { method: "GET", path: `${base}/:itemId`, route: `resource-${index}.read` },
      {
        method: "GET",
        path: `/api/v1/groups/group-${index}/items/:itemId`,
        route: `resource-${index}.deep-read`,
      },
    );
    validationRequests.push(
      {
        method: "GET",
        path: base,
        expectedRoute: `resource-${index}.list`,
        expectedPathParams: {},
      },
      {
        method: "POST",
        path: base,
        expectedRoute: `resource-${index}.create`,
        expectedPathParams: {},
      },
      {
        method: "GET",
        path: `${base}/validation-item`,
        expectedRoute: `resource-${index}.read`,
        expectedPathParams: { itemId: "validation-item" },
      },
      {
        method: "GET",
        path: `/api/v1/groups/group-${index}/items/validation-item`,
        expectedRoute: `resource-${index}.deep-read`,
        expectedPathParams: { itemId: "validation-item" },
      },
    );
  }

  const selected = [...new Set([0, Math.floor(resources / 2), resources - 1])];
  const requests: MatcherRequest[] = [];
  for (const index of selected) {
    requests.push(
      {
        method: "GET",
        path: `/catalog/resource-${index}`,
        expectedRoute: `resource-${index}.list`,
        expectedPathParams: {},
      },
      {
        method: "POST",
        path: `/catalog/resource-${index}`,
        expectedRoute: `resource-${index}.create`,
        expectedPathParams: {},
      },
      {
        method: "GET",
        path: `/catalog/resource-${index}/item-123`,
        expectedRoute: `resource-${index}.read`,
        expectedPathParams: { itemId: "item-123" },
      },
      {
        method: "GET",
        path: `/api/v1/groups/group-${index}/items/item-456`,
        expectedRoute: `resource-${index}.deep-read`,
        expectedPathParams: { itemId: "item-456" },
      },
    );
  }
  requests.push(
    {
      method: "DELETE",
      path: "/catalog/resource-0/item-123",
      expectedRoute: null,
      expectedPathParams: {},
    },
    {
      method: "GET",
      path: "/this/route/does/not/exist",
      expectedRoute: null,
      expectedPathParams: {},
    },
  );
  validationRequests.push(...requests);
  return { routeCount, routes, validationRequests, requests };
}

export function validateMatcher(
  name: MatcherName,
  matcher: RouteMatcher<string>,
  suite: MatcherSuite,
): void {
  for (const request of suite.validationRequests) {
    const match = matcher.match(request.method, request.path);
    if (request.expectedRoute === null) {
      if (match !== null) {
        throw new Error(
          `${name} incorrectly matched ${request.method} ${request.path} as ${match.route}.`,
        );
      }
      continue;
    }
    if (match === null || match.route !== request.expectedRoute) {
      throw new Error(
        `${name} matched ${request.method} ${request.path} as ${match?.route ?? "null"}; expected ${request.expectedRoute}.`,
      );
    }
    const actualParams = Object.entries(match.pathParams).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    const expectedParams = Object.entries(request.expectedPathParams).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    if (JSON.stringify(actualParams) !== JSON.stringify(expectedParams)) {
      throw new Error(
        `${name} returned path params ${JSON.stringify(Object.fromEntries(actualParams))} for ${request.path}; expected ${JSON.stringify(request.expectedPathParams)}.`,
      );
    }
  }
}

let resultSink = 0;

function batchedLookup(matcher: RouteMatcher<string>, requests: readonly MatcherRequest[]): void {
  let checksum = 0;
  for (let index = 0; index < MATCHER_SETTINGS.batchSize; index++) {
    const request = requests[index % requests.length]!;
    const match = matcher.match(request.method, request.path);
    checksum = Math.imul(checksum, 33) ^ (match?.route.length ?? 1);
  }
  resultSink ^= checksum;
}

export interface MatcherRoundSample {
  readonly routeCount: number;
  readonly round: number;
  readonly order: readonly MatcherName[];
  readonly matcher: MatcherName;
  readonly latencyMedianNsPerMatch: number;
  readonly latencyMeanNsPerMatch: number;
  readonly latencyP99NsPerMatch: number;
  readonly throughputMedianMatchesPerSecond: number;
  readonly throughputMeanMatchesPerSecond: number;
  readonly relativeMarginOfErrorPercent: number;
  readonly samples: number;
  readonly detectedResolutionNsPerBatch: number | undefined;
  readonly timerOverheadNsPerBatch: number | undefined;
}

function extractRoundSample(
  routeCount: number,
  round: number,
  order: readonly MatcherName[],
  matcher: MatcherName,
  task: Task,
  timerOverheadMilliseconds: number | undefined,
): MatcherRoundSample {
  const result = task.result;
  if (result.state !== "completed") {
    if (result.state === "errored") throw result.error;
    throw new Error(`${matcher} benchmark ended in unexpected state ${result.state}.`);
  }
  const metrics = [
    ["median latency", result.latency.p50],
    ["mean latency", result.latency.mean],
    ["p99 latency", result.latency.p99],
    ["median throughput", result.throughput.p50],
    ["mean throughput", result.throughput.mean],
  ] as const;
  for (const [name, value] of metrics) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${matcher} ${name} was ${value}.`);
    }
  }
  return {
    routeCount,
    round,
    order,
    matcher,
    latencyMedianNsPerMatch: mToNs(result.latency.p50) / MATCHER_SETTINGS.batchSize,
    latencyMeanNsPerMatch: mToNs(result.latency.mean) / MATCHER_SETTINGS.batchSize,
    latencyP99NsPerMatch: mToNs(result.latency.p99) / MATCHER_SETTINGS.batchSize,
    throughputMedianMatchesPerSecond: result.throughput.p50 * MATCHER_SETTINGS.batchSize,
    throughputMeanMatchesPerSecond: result.throughput.mean * MATCHER_SETTINGS.batchSize,
    relativeMarginOfErrorPercent: result.latency.rme,
    samples: result.latency.samplesCount,
    detectedResolutionNsPerBatch:
      task.detectedResolution === undefined ? undefined : mToNs(task.detectedResolution),
    timerOverheadNsPerBatch:
      timerOverheadMilliseconds === undefined ? undefined : mToNs(timerOverheadMilliseconds),
  };
}

export interface MatcherAggregate {
  readonly routeCount: number;
  readonly matcher: MatcherName;
  readonly latencyMedianNsPerMatch: DistributionSummary;
  readonly throughputMedianMatchesPerSecond: DistributionSummary;
  readonly pairedLatencyRatioToRadix: DistributionSummary;
}

export function aggregateMatcherSamples(
  samples: readonly MatcherRoundSample[],
): readonly MatcherAggregate[] {
  const output: MatcherAggregate[] = [];
  for (const routeCount of MATCHER_SETTINGS.routeSizes) {
    const radixByRound = new Map(
      samples
        .filter((sample) => sample.routeCount === routeCount && sample.matcher === "Radix")
        .map((sample) => [sample.round, sample.latencyMedianNsPerMatch]),
    );
    for (const matcher of ["Radix", "Regex"] as const) {
      const group = samples.filter(
        (sample) => sample.routeCount === routeCount && sample.matcher === matcher,
      );
      if (group.length === 0) continue;
      output.push({
        routeCount,
        matcher,
        latencyMedianNsPerMatch: summarize(group.map((sample) => sample.latencyMedianNsPerMatch)),
        throughputMedianMatchesPerSecond: summarize(
          group.map((sample) => sample.throughputMedianMatchesPerSecond),
        ),
        pairedLatencyRatioToRadix: summarize(
          group.map((sample) => {
            const radix = radixByRound.get(sample.round);
            if (radix === undefined) {
              throw new Error(
                `Missing Radix sample for ${routeCount} routes, round ${sample.round}.`,
              );
            }
            return sample.latencyMedianNsPerMatch / radix;
          }),
        ),
      });
    }
  }
  return output;
}

function formatOps(value: number): string {
  return `${(value / 1_000_000).toFixed(2)}M`;
}

function printSummary(aggregates: readonly MatcherAggregate[]): void {
  console.log("\nMedian of independent rounds; variability is median absolute deviation (MAD).\n");
  console.log(
    "  Routes  Matcher     ns/match median ± MAD      observed range    matches/s   latency vs Radix",
  );
  for (const row of aggregates) {
    const latency = `${row.latencyMedianNsPerMatch.median.toFixed(1)} ± ${row.latencyMedianNsPerMatch.mad.toFixed(1)}`;
    const range = `${row.latencyMedianNsPerMatch.min.toFixed(1)}–${row.latencyMedianNsPerMatch.max.toFixed(1)}`;
    console.log(
      `  ${String(row.routeCount).padStart(6)}  ${row.matcher.padEnd(7)} ${latency.padStart(24)} ${range.padStart(19)} ${formatOps(row.throughputMedianMatchesPerSecond.median).padStart(12)} ${`${row.pairedLatencyRatioToRadix.median.toFixed(3)}x`.padStart(18)}`,
    );
  }
}

async function main(): Promise<void> {
  const metadata = await benchmarkMetadata(resolve(import.meta.dir, ".."));
  const samples: MatcherRoundSample[] = [];
  const estimatedMilliseconds =
    MATCHER_SETTINGS.routeSizes.length *
    MATCHER_SETTINGS.rounds *
    2 *
    (MATCHER_SETTINGS.timeMilliseconds + MATCHER_SETTINGS.warmupMilliseconds);
  console.log(
    `Matcher benchmark: ${MATCHER_SETTINGS.rounds} rounds, ${MATCHER_SETTINGS.routeSizes.join(", ")} routes, ` +
      `${MATCHER_SETTINGS.warmupMilliseconds}ms warmup + ${MATCHER_SETTINGS.timeMilliseconds}ms measurement per task.`,
  );
  console.log(
    `Tinybench with Bun.nanoseconds, timer-overhead correction, ${MATCHER_SETTINGS.batchSize} lookups/sample; about ${(estimatedMilliseconds / 1_000).toFixed(0)}s.\n`,
  );

  try {
    for (const [sizeIndex, routeCount] of MATCHER_SETTINGS.routeSizes.entries()) {
      const suite = buildMatcherSuite(routeCount);
      for (let round = 1; round <= MATCHER_SETTINGS.rounds; round++) {
        const matchers = {
          Radix: createRadixMatcher(suite.routes),
          Regex: createRegexMatcher(suite.routes),
        } satisfies Record<MatcherName, RouteMatcher<string>>;
        validateMatcher("Radix", matchers.Radix, suite);
        validateMatcher("Regex", matchers.Regex, suite);

        const order: readonly MatcherName[] =
          (round + sizeIndex) % 2 === 0 ? ["Radix", "Regex"] : ["Regex", "Radix"];
        const warnings: string[] = [];
        const bench = new Bench({
          name: `${routeCount} routes, round ${round}`,
          time: MATCHER_SETTINGS.timeMilliseconds,
          warmupTime: MATCHER_SETTINGS.warmupMilliseconds,
          timestampProvider: "bunNanoseconds",
          subtractTimerOverhead: true,
          throws: true,
        });
        bench.addEventListener("warning", (event) => {
          warnings.push(`${event.task?.name ?? "unknown"}: ${event.reason ?? "unknown"}`);
        });
        for (const matcher of order) {
          bench.add(matcher, () => batchedLookup(matchers[matcher], suite.requests), {
            async: false,
          });
        }
        bench.runSync();
        if (warnings.length > 0) {
          throw new Error(`Tinybench timer saturation detected: ${warnings.join(", ")}.`);
        }
        for (const matcher of ["Radix", "Regex"] as const) {
          const task = bench.getTask(matcher);
          if (!task) throw new Error(`Tinybench did not retain the ${matcher} task.`);
          samples.push(
            extractRoundSample(routeCount, round, order, matcher, task, bench.timerOverhead),
          );
        }
        const radix = samples.at(-2)!;
        const regex = samples.at(-1)!;
        console.log(
          `${String(routeCount).padStart(4)} routes, round ${round}/${MATCHER_SETTINGS.rounds}, order ${order.join("→")}: ` +
            `Radix ${radix.latencyMedianNsPerMatch.toFixed(1)} ns, Regex ${regex.latencyMedianNsPerMatch.toFixed(1)} ns`,
        );
      }
    }
  } catch (error) {
    const path = await writeBenchmarkArtifact("matchers", {
      schemaVersion: 1,
      kind: "matchers",
      complete: false,
      metadata,
      settings: MATCHER_SETTINGS,
      samples,
      resultSink,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { message: String(error) },
    });
    console.error(`\nBenchmark failed. Partial diagnostic artifact: ${path}`);
    throw error;
  }

  const aggregates = aggregateMatcherSamples(samples);
  printSummary(aggregates);
  const artifactPath = await writeBenchmarkArtifact("matchers", {
    schemaVersion: 1,
    kind: "matchers",
    complete: true,
    metadata,
    settings: MATCHER_SETTINGS,
    samples,
    aggregates,
    resultSink,
  });
  console.log(`\nRound results, settings, and machine metadata: ${artifactPath}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  }
}
