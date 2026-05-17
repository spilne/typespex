import autocannon from "autocannon";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DURATION = 10;
const CONNECTIONS = 50;
const PIPELINING = 10;

const SERVERS = [
  { name: "Bare Bun", port: 3457 },
  { name: "Hono", port: 3458 },
  { name: "Hono+Zod", port: 3459 },
  { name: "typespex", port: 3456 },
] as const;

const SCENARIOS = [
  { name: "GET  /pets?limit=10", path: "/pets?limit=10" },
  { name: "GET  /pets/:id (404)", path: "/pets/nonexistent" },
  {
    name: "POST /pets (create)",
    path: "/pets",
    method: "POST" as const,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Bench", tag: "test" }),
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

async function runScenario(url: string): Promise<autocannon.Result> {
  return new Promise((resolve, reject) => {
    const instance = autocannon(
      { url, duration: DURATION, connections: CONNECTIONS, pipelining: PIPELINING },
      (err, result) => (err ? reject(err) : resolve(result)),
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

async function seedPets(port: number, count: number) {
  for (let i = 0; i < count; i++) {
    const res = await fetch(`http://localhost:${port}/pets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `Pet${i}`, tag: `tag${i % 5}` }),
    });
    await res.arrayBuffer();
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

  for (const s of active) await seedPets(s.port, 20);

  console.log(`autocannon — ${CONNECTIONS} connections, ${PIPELINING} pipelining, ${DURATION}s\n`);

  for (const scenario of SCENARIOS) {
    const rows: Row[] = [];
    for (const server of active) {
      const result = await runScenario(`http://localhost:${server.port}${scenario.path}`);
      rows.push(extractRow(server.name, result));
    }
    printTable(scenario.name, rows);
  }
}

main();
