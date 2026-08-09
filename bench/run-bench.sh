#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

PIDS=()
LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/typespex-bench.XXXXXX")"

cleanup() {
  local status=$?
  trap - EXIT INT TERM

  if ((${#PIDS[@]} > 0)); then
    kill "${PIDS[@]}" 2>/dev/null || true
    for pid in "${PIDS[@]}"; do
      wait "$pid" 2>/dev/null || true
    done
  fi

  if [[ -n "$LOG_DIR" && "$LOG_DIR" == */typespex-bench.* ]]; then
    rm -rf -- "$LOG_DIR"
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if ! command -v lsof >/dev/null 2>&1; then
  echo "run-bench.sh requires lsof to verify that benchmark ports are available." >&2
  exit 1
fi

for port in 3456 3457 3458 3459; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "Port $port is already in use; refusing to stop an unrelated process." >&2
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2 || true
    exit 1
  fi
done

TYPESPEX_BENCHMARK=1 bun run ../example/server.ts >"$LOG_DIR/typespex.log" 2>&1 &
PIDS+=("$!")
bun run bench-baseline.ts >"$LOG_DIR/baseline.log" 2>&1 &
PIDS+=("$!")
bun run bench-hono.ts >"$LOG_DIR/hono.log" 2>&1 &
PIDS+=("$!")
bun run bench-hono-zod.ts >"$LOG_DIR/hono-zod.log" 2>&1 &
PIDS+=("$!")

wait_for_server() {
  local name=$1
  local port=$2
  local pid=$3
  local log_file=$4

  local attempt
  for ((attempt = 0; attempt < 100; attempt++)); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "$name exited before becoming healthy on port $port." >&2
      sed -n '1,160p' "$log_file" >&2
      exit 1
    fi
    if curl --max-time 1 -sf "http://127.0.0.1:$port/pets" >/dev/null &&
      kill -0 "$pid" 2>/dev/null; then
      echo "  $name ($port): OK"
      return
    fi
    sleep 0.1
  done

  echo "$name did not become healthy on port $port within 10 seconds." >&2
  sed -n '1,160p' "$log_file" >&2
  exit 1
}

echo "Checking servers..."
wait_for_server "typespex" 3456 "${PIDS[0]}" "$LOG_DIR/typespex.log"
wait_for_server "baseline" 3457 "${PIDS[1]}" "$LOG_DIR/baseline.log"
wait_for_server "hono" 3458 "${PIDS[2]}" "$LOG_DIR/hono.log"
wait_for_server "hono+zod" 3459 "${PIDS[3]}" "$LOG_DIR/hono-zod.log"
echo ""

bun run bench.ts &
BENCH_PID=$!
PIDS+=("$BENCH_PID")
wait "$BENCH_PID"
