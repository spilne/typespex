import { createRadixMatcher, createRegexMatcher, type RouteMatcher } from "@typespex/runtime";

const routes = [
  { method: "GET", path: "/pets", route: "pets.list" },
  { method: "POST", path: "/pets", route: "pets.create" },
  { method: "GET", path: "/pets/:petId", route: "pets.read" },
  { method: "DELETE", path: "/pets/:petId", route: "pets.delete" },
  { method: "GET", path: "/users", route: "users.list" },
  { method: "POST", path: "/users", route: "users.create" },
  { method: "GET", path: "/users/:userId", route: "users.read" },
  { method: "PUT", path: "/users/:userId", route: "users.update" },
  { method: "DELETE", path: "/users/:userId", route: "users.delete" },
  { method: "GET", path: "/users/:userId/posts", route: "posts.list" },
  { method: "POST", path: "/users/:userId/posts", route: "posts.create" },
  { method: "GET", path: "/users/:userId/posts/:postId", route: "posts.read" },
  { method: "PUT", path: "/users/:userId/posts/:postId", route: "posts.update" },
  { method: "DELETE", path: "/users/:userId/posts/:postId", route: "posts.delete" },
  { method: "GET", path: "/health", route: "health" },
  { method: "GET", path: "/api/v1/config", route: "config.read" },
];

const requests = [
  { method: "GET", path: "/pets", label: "GET  /pets" },
  { method: "GET", path: "/pets/abc-123", label: "GET  /pets/:id" },
  { method: "POST", path: "/pets", label: "POST /pets" },
  { method: "DELETE", path: "/pets/abc-123", label: "DEL  /pets/:id" },
  { method: "GET", path: "/users/u1/posts/p1", label: "GET  deep nested" },
  { method: "GET", path: "/api/v1/config", label: "GET  long static" },
  { method: "GET", path: "/health", label: "GET  /health" },
  { method: "GET", path: "/not/a/route", label: "GET  miss (404)" },
];

const WARMUP = 5_000;
const ITERATIONS = 100_000;

function bench(name: string, matcher: RouteMatcher<string>) {
  // Warmup
  for (let w = 0; w < WARMUP; w++) {
    const r = requests[w % requests.length];
    matcher.match(r.method, r.path);
  }

  const results: Array<{ label: string; nsPerOp: number }> = [];

  for (const req of requests) {
    const start = Bun.nanoseconds();
    for (let i = 0; i < ITERATIONS; i++) {
      matcher.match(req.method, req.path);
    }
    const elapsed = Bun.nanoseconds() - start;
    results.push({ label: req.label, nsPerOp: elapsed / ITERATIONS });
  }

  return { name, results };
}

const radix = createRadixMatcher(routes);
const regex = createRegexMatcher(routes);

const radixResults = bench("Radix", radix);
const regexResults = bench("Regex", regex);

console.log(
  `${ITERATIONS.toLocaleString()} iterations per request pattern, ${routes.length} routes\n`,
);
function fmtNs(ns: number): string {
  return ns.toFixed(1).padStart(7) + " ns";
}
function fmtRps(ns: number): string {
  return (1_000_000_000 / ns)
    .toFixed(0)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    .padStart(11);
}

console.log(
  "┌──────────────────┬────────────┬─────────────┬────────────┬─────────────┬──────────┐",
);
console.log(
  "│ Request          │   Radix    │  Radix ops/s│   Regex    │  Regex ops/s│  Δ       │",
);
console.log(
  "├──────────────────┼────────────┼─────────────┼────────────┼─────────────┼──────────┤",
);

for (let i = 0; i < requests.length; i++) {
  const r = radixResults.results[i];
  const x = regexResults.results[i];
  const delta = (((x.nsPerOp - r.nsPerOp) / r.nsPerOp) * 100).toFixed(0);
  const sign = x.nsPerOp < r.nsPerOp ? "" : "+";
  console.log(
    `│ ${r.label.padEnd(16)} │ ${fmtNs(r.nsPerOp)} │ ${fmtRps(r.nsPerOp)} │ ${fmtNs(x.nsPerOp)} │ ${fmtRps(x.nsPerOp)} │ ${(sign + delta + "%").padStart(8)} │`,
  );
}

console.log(
  "└──────────────────┴────────────┴─────────────┴────────────┴─────────────┴──────────┘",
);

const radixAvg =
  radixResults.results.reduce((s, r) => s + r.nsPerOp, 0) / radixResults.results.length;
const regexAvg =
  regexResults.results.reduce((s, r) => s + r.nsPerOp, 0) / regexResults.results.length;
const avgDelta = (((regexAvg - radixAvg) / radixAvg) * 100).toFixed(0);
const avgSign = regexAvg < radixAvg ? "" : "+";
console.log(
  `\n  Average:          ${fmtNs(radixAvg)}   ${fmtRps(radixAvg)}   ${fmtNs(regexAvg)}   ${fmtRps(regexAvg)}   ${avgSign}${avgDelta}%`,
);
