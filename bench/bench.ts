import autocannon from "autocannon";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function positiveIntegerSetting(name: string, fallback: number): number {
  const raw = Bun.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

const DURATION = positiveIntegerSetting("TYPESPEX_BENCH_DURATION", 10);
const CONNECTIONS = positiveIntegerSetting("TYPESPEX_BENCH_CONNECTIONS", 50);
const PIPELINING = positiveIntegerSetting("TYPESPEX_BENCH_PIPELINING", 10);

export const SERVERS = [
  { name: "Bare Bun", port: 3457 },
  { name: "Hono", port: 3458 },
  { name: "Hono+Zod", port: 3459 },
  { name: "typespex", port: 3456 },
] as const;

export interface BenchmarkScenario {
  readonly name: string;
  readonly path: string;
  readonly method?: autocannon.Request["method"];
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly expectedStatus: number;
}

export type FetchRequest = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface BenchmarkServer {
  readonly name: string;
  readonly port: number;
}

export const SCENARIOS: readonly BenchmarkScenario[] = [
  { name: "GET  /pets?limit=10", path: "/pets?limit=10", expectedStatus: 200 },
  { name: "GET  /pets/:id (404)", path: "/pets/nonexistent", expectedStatus: 404 },
  {
    name: "POST /pets (create)",
    path: "/pets",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Bench", tag: "test" }),
    expectedStatus: 200,
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface Row {
  server: string;
  reqSec: number;
  avg: number;
  p50: number;
  p99: number;
  total: number;
}

export function autocannonOptions(url: string, scenario: BenchmarkScenario): autocannon.Options {
  return {
    url,
    duration: DURATION,
    connections: CONNECTIONS,
    pipelining: PIPELINING,
    method: scenario.method ?? "GET",
    headers: scenario.headers,
    body: scenario.body,
  };
}

async function runScenario(url: string, scenario: BenchmarkScenario): Promise<autocannon.Result> {
  return new Promise((resolve, reject) => {
    const instance = autocannon(autocannonOptions(url, scenario), (err, result) =>
      err ? reject(err) : resolve(result),
    );
    autocannon.track(instance, { renderProgressBar: false });
  });
}

function extractRow(server: string, result: autocannon.Result): Row {
  const r = result.requests as any;
  const l = result.latency as any;
  return {
    server,
    reqSec: r.average ?? r.mean,
    avg: l.average ?? l.mean,
    p50: l.p50,
    p99: l.p99,
    total: r.total,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function col(v: number, w = 8): string {
  return String(Math.round(v)).padStart(w);
}

function printTable(title: string, rows: Row[]) {
  console.log(`--- ${title} ---`);
  console.log("┌────────────┬──────────┬──────────┬──────────┬──────────┬──────────┐");
  console.log("│ Server     │   req/s  │  avg ms  │  p50 ms  │  p99 ms  │   total  │");
  console.log("├────────────┼──────────┼──────────┼──────────┼──────────┼──────────┤");
  for (const r of rows) {
    console.log(
      `│ ${r.server.padEnd(10)} │${col(r.reqSec)} │${col(r.avg)} │${col(r.p50)} │${col(r.p99)} │${col(r.total)} │`,
    );
  }
  console.log("└────────────┴──────────┴──────────┴──────────┴──────────┴──────────┘\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function isAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/pets`);
    await res.arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

export async function seedPets(
  server: BenchmarkServer,
  count: number,
  fetchRequest: FetchRequest = fetch,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    const res = await fetchRequest(`http://localhost:${server.port}/pets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `Pet${i}`, tag: `tag${i % 5}` }),
    });
    await res.arrayBuffer();
    if (res.status !== 200) {
      throw new Error(
        `${server.name} seed request ${i + 1}/${count} returned ${res.status}; expected 200.`,
      );
    }
  }
}

export async function validateScenario(
  url: string,
  scenario: BenchmarkScenario,
  fetchRequest: FetchRequest = fetch,
): Promise<void> {
  const response = await fetchRequest(url, {
    method: scenario.method ?? "GET",
    headers: scenario.headers,
    body: scenario.body,
  });
  await response.arrayBuffer();
  if (response.status !== scenario.expectedStatus) {
    throw new Error(
      `${scenario.name} preflight returned ${response.status}; expected ${scenario.expectedStatus} for ${scenario.method ?? "GET"} ${url}.`,
    );
  }
}

async function main() {
  const active = [];
  for (const s of SERVERS) {
    if (await isAlive(s.port)) active.push(s);
  }
  if (active.length === 0) {
    console.error("No servers running.");
    process.exit(1);
  }

  for (const s of active) await seedPets(s, 20);

  console.log(`autocannon — ${CONNECTIONS} connections, ${PIPELINING} pipelining, ${DURATION}s\n`);

  for (const scenario of SCENARIOS) {
    const rows: Row[] = [];
    for (const server of active) {
      const url = `http://localhost:${server.port}${scenario.path}`;
      await validateScenario(url, scenario);
      const result = await runScenario(url, scenario);
      rows.push(extractRow(server.name, result));
    }
    printTable(scenario.name, rows);
  }
}

if (import.meta.main) {
  await main();
}
