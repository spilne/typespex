import { describe, expect, test } from "bun:test";
import { createRadixMatcher, createRegexMatcher } from "@typespex/runtime";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateSamples,
  autocannonOptions,
  type BenchmarkScenario,
  createSchedule,
  fetchWithTimeout,
  type HttpSample,
  SCENARIOS,
  SERVERS,
  type ValidatableAutocannonResult,
  validateAutocannonResult,
  validateScenario,
} from "./bench.js";
import { balancedOrder, installedPackageVersion, median, summarize } from "./benchmark-common.js";
import {
  aggregateMatcherSamples,
  buildMatcherSuite,
  MATCHER_SETTINGS,
  type MatcherRoundSample,
  validateMatcher,
} from "./bench-matchers.js";
import { CREATED_PET, createPetFixture } from "./fixture.js";

function resultFor(
  status: number,
  total = 100,
  overrides: Partial<ValidatableAutocannonResult> = {},
): ValidatableAutocannonResult {
  return {
    requests: { average: 1_000, sent: total, total },
    latency: { average: 1, p50: 1, p99: 2, max: 3 },
    throughput: { average: 10_000 },
    duration: 1,
    errors: 0,
    timeouts: 0,
    mismatches: 0,
    resets: 0,
    non2xx: status >= 200 && status < 300 ? 0 : total,
    statusCodeStats: { [String(status)]: { count: total } },
    ...overrides,
  };
}

describe("HTTP benchmark validation", () => {
  test("passes the complete create request and expected body to autocannon", () => {
    const create = SCENARIOS.find((scenario) => scenario.id === "create")!;
    const options = autocannonOptions("http://127.0.0.1:3456/pets", create, 3);
    expect(options).toMatchObject({
      method: "POST",
      duration: 3,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bench", tag: "test" }),
      expectBody: JSON.stringify(CREATED_PET),
      bailout: 1,
    });
  });

  test("preflight checks method, status, content type, and exact response body", async () => {
    const scenario: BenchmarkScenario = {
      id: "created",
      name: "POST /items",
      path: "/items",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"name":"Bench"}',
      expectedStatus: 201,
      expectedBody: '{"id":"item-1"}',
    };
    let received:
      | { readonly input: string | URL | Request; readonly init?: RequestInit }
      | undefined;

    await validateScenario(
      "http://127.0.0.1:3456/items",
      scenario,
      "test preflight",
      async (input, init) => {
        received = { input, init };
        return new Response('{"id":"item-1"}', {
          status: 201,
          headers: { "content-type": "application/json; charset=UTF-8" },
        });
      },
    );

    expect(received).toEqual({
      input: "http://127.0.0.1:3456/items",
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"name":"Bench"}',
      },
    });
  });

  test("preflight rejects a status/body/content-type mismatch", async () => {
    const create = SCENARIOS.find((scenario) => scenario.id === "create")!;
    await expect(
      validateScenario(
        "http://127.0.0.1:3456/pets",
        create,
        "preflight",
        async () => new Response("not found", { status: 404 }),
      ),
    ).rejects.toThrow("status 404, expected 200");
  });

  test("validation fetches abort instead of hanging past their deadline", async () => {
    let signal: AbortSignal | undefined;
    const boundedFetch = fetchWithTimeout(1, async (_input, init) => {
      signal = init?.signal ?? undefined;
      if (!signal) throw new Error("Expected an abort signal.");
      return await new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      });
    });

    const rejection = await boundedFetch("http://127.0.0.1/hangs").catch((error) => error);
    expect(rejection).toBeInstanceOf(DOMException);
    expect(signal?.aborted).toBeTrue();
  });

  test("timed validation accepts exact success and modeled-error distributions", () => {
    const create = SCENARIOS.find((scenario) => scenario.id === "create")!;
    const notFound = SCENARIOS.find((scenario) => scenario.id === "not-found")!;
    expect(() => validateAutocannonResult(resultFor(200), create, "measurement")).not.toThrow();
    expect(() => validateAutocannonResult(resultFor(404), notFound, "measurement")).not.toThrow();
  });

  test("timed validation rejects transport errors, body mismatches, and hidden statuses", () => {
    const create = SCENARIOS.find((scenario) => scenario.id === "create")!;
    const invalid = resultFor(200, 100, {
      errors: 1,
      mismatches: 2,
      non2xx: 1,
      statusCodeStats: { "200": { count: 99 }, "500": { count: 1 } },
    });
    expect(() => validateAutocannonResult(invalid, create, "measurement")).toThrow(
      "1 connection errors",
    );
    expect(() => validateAutocannonResult(invalid, create, "measurement")).toThrow(
      "unexpected statuses 500:1",
    );
  });

  test("timed validation rejects corrupt numeric statistics", () => {
    const create = SCENARIOS.find((scenario) => scenario.id === "create")!;
    expect(() =>
      validateAutocannonResult(
        resultFor(200, 100, {
          requests: { average: Number.NaN, sent: 99, total: 100 },
        }),
        create,
        "measurement",
      ),
    ).toThrow("request rate was NaN");
  });

  test("four trials rotate every server through every position for each scenario", () => {
    const schedule = createSchedule({
      durationSeconds: 1,
      warmupSeconds: 1,
      trials: 4,
      connections: 1,
      pipelining: 1,
      timeoutSeconds: 1,
      seed: "schedule-test",
    });
    expect(schedule).toHaveLength(4 * 3 * 4);
    for (const scenario of SCENARIOS) {
      const positions = new Map<string, Set<number>>();
      for (let trial = 1; trial <= 4; trial++) {
        const cells = schedule.filter(
          (cell) => cell.trial === trial && cell.scenarioId === scenario.id,
        );
        expect(cells).toHaveLength(4);
        cells.forEach((cell, position) => {
          const seen = positions.get(cell.serverId) ?? new Set<number>();
          seen.add(position);
          positions.set(cell.serverId, seen);
        });
      }
      expect([...positions.values()].every((seen) => seen.size === 4)).toBeTrue();
    }
  });
});

describe("benchmark statistics and fixtures", () => {
  test("reports robust center and spread without mutating inputs", () => {
    const values = [100, 1, 3, 2];
    expect(median(values)).toBe(2.5);
    expect(summarize(values)).toEqual({ median: 2.5, mad: 1, min: 1, max: 100 });
    expect(values).toEqual([100, 1, 3, 2]);
  });

  test("balanced order is deterministic and rotates all positions", () => {
    const values = ["a", "b", "c", "d"];
    const orders = values.map((_, trial) => balancedOrder(values, trial, "fixed"));
    expect(orders).toEqual(values.map((_, trial) => balancedOrder(values, trial, "fixed")));
    for (const value of values) {
      expect(new Set(orders.map((order) => order.indexOf(value))).size).toBe(values.length);
    }
  });

  test("create responses are deterministic and do not grow the shared collection", () => {
    const fixture = createPetFixture();
    expect(fixture.list().length).toBe(20);
    expect(fixture.create({ name: "Bench", tag: "test" })).toEqual(CREATED_PET);
    expect(fixture.create({ name: "Bench", tag: "test" })).toEqual(CREATED_PET);
    expect(fixture.list().length).toBe(20);
  });

  test("dependency metadata falls back to a hoisted root package", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "typespex-benchmark-"));
    try {
      const packageDirectory = join(repositoryRoot, "node_modules", "hoisted-dependency");
      await mkdir(packageDirectory, { recursive: true });
      await Bun.write(join(packageDirectory, "package.json"), '{"version":"1.2.3"}');
      expect(await installedPackageVersion(repositoryRoot, "hoisted-dependency")).toBe("1.2.3");
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  test("generated matcher suites are semantically valid before timing", () => {
    const suite = buildMatcherSuite(16);
    expect(suite.routes).toHaveLength(16);
    expect(suite.validationRequests.length).toBeGreaterThanOrEqual(18);
    validateMatcher("Radix", createRadixMatcher(suite.routes), suite);
    validateMatcher("Regex", createRegexMatcher(suite.routes), suite);
  });

  test("HTTP summaries pair each implementation with the same-trial baseline", () => {
    const scenario = SCENARIOS[0]!;
    const makeSample = (serverId: string, trial: number, requestsPerSecond: number): HttpSample => {
      const server = SERVERS.find((candidate) => candidate.id === serverId)!;
      return {
        trial,
        sequence: 0,
        serverId,
        server: server.name,
        scenarioId: scenario.id,
        scenario: scenario.name,
        requestsPerSecond,
        requestsTotal: 1,
        requestsSent: 1,
        latencyAverageMs: 1,
        latencyP50Ms: 1,
        latencyP99Ms: 2,
        latencyMaxMs: 3,
        throughputAverageBytesPerSecond: 1,
        durationSeconds: 1,
        errors: 0,
        timeouts: 0,
        mismatches: 0,
        resets: 0,
        non2xx: 0,
        statusCodes: { "200": 1 },
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
      };
    };
    const aggregates = aggregateSamples([
      makeSample("bare-bun", 1, 100),
      makeSample("hono", 1, 80),
      makeSample("bare-bun", 2, 200),
      makeSample("hono", 2, 220),
    ]);
    const hono = aggregates.find((aggregate) => aggregate.serverId === "hono")!;
    expect(hono.requestsPerSecond.median).toBe(150);
    expect(hono.throughputRatioToBare.median).toBeCloseTo(0.95);
    expect(hono.throughputRatioToBare.mad).toBeCloseTo(0.15);
  });

  test("matcher summaries use round-paired latency ratios", () => {
    const routeCount = MATCHER_SETTINGS.routeSizes[0]!;
    const makeSample = (
      matcher: "Radix" | "Regex",
      round: number,
      latency: number,
    ): MatcherRoundSample => ({
      routeCount,
      round,
      order: ["Radix", "Regex"],
      matcher,
      latencyMedianNsPerMatch: latency,
      latencyMeanNsPerMatch: latency,
      latencyP99NsPerMatch: latency,
      throughputMedianMatchesPerSecond: 1_000_000_000 / latency,
      throughputMeanMatchesPerSecond: 1_000_000_000 / latency,
      relativeMarginOfErrorPercent: 1,
      samples: 100,
      detectedResolutionNsPerBatch: 1,
      timerOverheadNsPerBatch: 1,
    });
    const aggregates = aggregateMatcherSamples([
      makeSample("Radix", 1, 100),
      makeSample("Regex", 1, 120),
      makeSample("Radix", 2, 200),
      makeSample("Regex", 2, 100),
    ]);
    const regex = aggregates.find(
      (aggregate) => aggregate.routeCount === routeCount && aggregate.matcher === "Regex",
    )!;
    expect(regex.pairedLatencyRatioToRadix.median).toBeCloseTo(0.85);
    expect(regex.pairedLatencyRatioToRadix.mad).toBeCloseTo(0.35);
  });
});
