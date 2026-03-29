#!/bin/bash
set -e
cd "$(dirname "$0")"

# Kill old processes
kill $(lsof -ti :3456) 2>/dev/null || true
kill $(lsof -ti :3457) 2>/dev/null || true
sleep 0.5

# Start servers
bun run server.ts > /dev/null 2>&1 &
PID1=$!
bun run bench-baseline.ts > /dev/null 2>&1 &
PID2=$!
sleep 2

# Verify
echo "Checking servers..."
curl -sf http://localhost:3456/pets > /dev/null && echo "  typespex (3456): OK"
curl -sf http://localhost:3457/pets > /dev/null && echo "  baseline  (3457): OK"
echo ""

# Benchmark
bun run bench.ts

# Cleanup
kill $PID1 $PID2 2>/dev/null || true
wait $PID1 $PID2 2>/dev/null || true
