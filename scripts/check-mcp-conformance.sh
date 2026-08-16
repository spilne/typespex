#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

readonly conformance_version="0.2.0-alpha.11"
readonly protocol_version="2026-07-28"
readonly fixture="packages/mcp-emitter/test/conformance"
readonly port="${TYPESPEX_MCP_CONFORMANCE_PORT:-3300}"
readonly results=".context/mcp-conformance-results"

output_dir=$(mktemp -d "example/.mcp-conformance.XXXXXX")
server_pid=""

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$output_dir"
  exit "$status"
}
trap cleanup EXIT INT TERM

bun run --filter @typespex/codec build
bun run --filter @typespex/http-client build
bun run --filter @typespex/compiler-core build
bun run --filter @typespex/mcp build
bun run --filter @typespex/mcp-server build
bun run --filter @typespex/mcp-http-bridge build
bun run --filter @typespex/mcp-transport-http build
bun run --filter @typespex/mcp-transport-stdio build
bun run --filter @typespex/http-server build
bun run --filter @typespex/adapter-node build
bun run --filter @typespex/mcp-emitter build

TYPESPEC_SKIP_COMPILER_RESOLVE=1 node node_modules/@typespec/compiler/cmd/tsp.js compile "$fixture/main.tsp" \
  --config "$fixture/tspconfig.yaml" \
  --output-dir "$output_dir"
cp "$fixture/application.ts" "$output_dir/conformance-tools/application.ts"
cp "$fixture/tsconfig.json" "$output_dir/conformance-tools/tsconfig.json"
node packages/mcp-emitter/node_modules/typescript/bin/tsc \
  --project "$output_dir/conformance-tools/tsconfig.json"

rm -rf "$results"
mkdir -p "$results"
TYPESPEX_MCP_CONFORMANCE_PORT="$port" \
  bun "$output_dir/conformance-tools/mcp-node.ts" \
  >"$results/server-stdout.log" \
  2>"$results/server-stderr.log" &
server_pid=$!

server_ready=false
for _ in {1..50}; do
  if curl --silent --output /dev/null --request POST "http://127.0.0.1:$port/mcp"; then
    server_ready=true
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    printf 'Generated MCP conformance server exited during startup.\n' >&2
    exit 1
  fi
  sleep 0.1
done
if [[ "$server_ready" != "true" ]]; then
  printf 'Timed out waiting for the generated MCP conformance server.\n' >&2
  exit 1
fi

npx -y "@modelcontextprotocol/conformance@$conformance_version" server \
  --url "http://127.0.0.1:$port/mcp" \
  --suite all \
  --spec-version "$protocol_version" \
  --expected-failures "$fixture/expected-failures.yaml" \
  --output-dir "$results"

node --input-type=module - "$fixture/expected-failures.yaml" "$results" <<'NODE'
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [baselineFile, resultsDirectory] = process.argv.slice(2);
const expected = new Set(
  readFileSync(baselineFile, "utf8")
    .split(/\r?\n/)
    .flatMap((line) => /^\s*-\s+([A-Za-z0-9_.-]+)\s*$/.exec(line)?.[1] ?? []),
);
const actual = new Set();
for (const directory of readdirSync(resultsDirectory, { withFileTypes: true })) {
  if (!directory.isDirectory()) continue;
  const match = /^server-(.+)-(\d{4}-\d{2}-\d{2}T.*Z)$/.exec(directory.name);
  if (!match) continue;
  const checks = JSON.parse(readFileSync(join(resultsDirectory, directory.name, "checks.json"), "utf8"));
  if (checks.some((check) => check.status === "FAILURE" || check.status === "WARNING")) {
    actual.add(match[1]);
  }
}
const stale = [...expected].filter((scenario) => !actual.has(scenario));
const unexpected = [...actual].filter((scenario) => !expected.has(scenario));
if (stale.length || unexpected.length) {
  throw new Error(
    [
      stale.length ? `Stale expected failures: ${stale.join(", ")}` : "",
      unexpected.length ? `Unexpected failures: ${unexpected.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}
console.log(`Verified an exact, non-stale baseline of ${expected.size} failing scenarios.`);
NODE

printf 'MCP conformance evidence written to %s\n' "$results"
