#!/usr/bin/env bash
set -euo pipefail
BENCH_DIR="$(cd "$(dirname "$0")" && pwd)"
REPOSITORY_ROOT="$(cd "$BENCH_DIR/.." && pwd)"
cd "$REPOSITORY_ROOT"

if command -v lsof >/dev/null 2>&1; then
  for port in 3456 3457 3458 3459; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
      echo "Port $port is already in use; refusing to stop an unrelated process." >&2
      lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2 || true
      exit 1
    fi
  done
fi

echo "Building current sources and checking generated fixtures..."
bun run build
bun run check:generated
exec bun run bench/bench.ts
