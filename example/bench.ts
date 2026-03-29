const WARMUP = 500;
const ITERATIONS = 5000;

interface BenchResult {
  name: string;
  avgUs: number;
  minUs: number;
  maxUs: number;
  p50Us: number;
  p99Us: number;
  rps: number;
}

async function bench(
  name: string,
  baseUrl: string,
  petId: string,
): Promise<BenchResult> {
  const requests = [
    () => fetch(`${baseUrl}/pets`),
    () => fetch(`${baseUrl}/pets?limit=1`),
    () => fetch(`${baseUrl}/pets/${petId}`),
    () => fetch(`${baseUrl}/pets/nonexistent`),
    () => fetch(`${baseUrl}/unknown`),
  ];

  // Warmup
  for (let i = 0; i < WARMUP; i++) {
    const res = await requests[i % requests.length]();
    await res.text();
  }

  // Measure
  const times: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const fn = requests[i % requests.length];
    const start = Bun.nanoseconds();
    const res = await fn();
    await res.text();
    const elapsed = Bun.nanoseconds() - start;
    times.push(elapsed / 1000); // to microseconds
  }

  times.sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);

  return {
    name,
    avgUs: sum / times.length,
    minUs: times[0],
    maxUs: times[times.length - 1],
    p50Us: times[Math.floor(times.length * 0.5)],
    p99Us: times[Math.floor(times.length * 0.99)],
    rps: Math.round(1_000_000 / (sum / times.length)),
  };
}

function fmt(us: number): string {
  return us.toFixed(1).padStart(8) + " µs";
}

async function seedAndBench(name: string, baseUrl: string): Promise<BenchResult> {
  // Seed a pet
  const res = await fetch(`${baseUrl}/pets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Bench", tag: "test" }),
  });
  const pet = (await res.json()) as { id: string };
  return bench(name, baseUrl, pet.id);
}

async function main() {
  console.log(`Warming up ${WARMUP} requests, then measuring ${ITERATIONS} requests per server...\n`);

  const baseline = await seedAndBench("Bare Bun", "http://localhost:3457");
  const shim = await seedAndBench("typespex", "http://localhost:3456");

  console.log("┌────────────┬────────────┬────────────┬────────────┬────────────┬────────────┬──────────┐");
  console.log("│ Server     │    avg     │    min     │    p50     │    p99     │    max     │   req/s  │");
  console.log("├────────────┼────────────┼────────────┼────────────┼────────────┼────────────┼──────────┤");
  for (const r of [baseline, shim]) {
    console.log(
      `│ ${r.name.padEnd(10)} │ ${fmt(r.avgUs)} │ ${fmt(r.minUs)} │ ${fmt(r.p50Us)} │ ${fmt(r.p99Us)} │ ${fmt(r.maxUs)} │ ${String(r.rps).padStart(8)} │`,
    );
  }
  console.log("└────────────┴────────────┴────────────┴────────────┴────────────┴────────────┴──────────┘");

  const overhead = ((shim.avgUs - baseline.avgUs) / baseline.avgUs * 100).toFixed(1);
  console.log(`\nOverhead: ${overhead}% (${(shim.avgUs - baseline.avgUs).toFixed(1)} µs per request)`);
}

main();
