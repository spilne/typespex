#!/bin/bash
set -e
cd "$(dirname "$0")"

# Kill old processes
kill $(lsof -ti :3456) 2>/dev/null || true
kill $(lsof -ti :3457) 2>/dev/null || true
kill $(lsof -ti :3458) 2>/dev/null || true
kill $(lsof -ti :3459) 2>/dev/null || true
sleep 0.5

# Start servers
bun run ../example/server.ts > /dev/null 2>&1 &
PID1=$!
bun run bench-baseline.ts > /dev/null 2>&1 &
PID2=$!
bun run bench-hono.ts > /dev/null 2>&1 &
PID3=$!
bun run bench-hono-zod.ts > /dev/null 2>&1 &
PID4=$!
sleep 2

# Verify
echo "Checking servers..."
curl -sf http://localhost:3456/pets > /dev/null && echo "  typespex  (3456): OK"
curl -sf http://localhost:3457/pets > /dev/null && echo "  baseline  (3457): OK"
curl -sf http://localhost:3458/pets > /dev/null && echo "  hono      (3458): OK"
curl -sf http://localhost:3459/pets > /dev/null && echo "  hono+zod  (3459): OK"
echo ""

# Benchmark
bun run bench.ts

# Cleanup
kill $PID1 $PID2 $PID3 $PID4 2>/dev/null || true
wait $PID1 $PID2 $PID3 $PID4 2>/dev/null || true
