#!/bin/bash
set -e

# Publish all packages to npm in dependency order.
# workspace:* references are resolved by bun publish automatically.
#
# Usage:
#   ./scripts/publish.sh          # dry-run
#   ./scripts/publish.sh --run    # actually publish

DRY_RUN="--dry-run"
if [ "$1" = "--run" ]; then
  DRY_RUN=""
fi

echo "Building all packages..."
bun run build

echo "Running tests..."
bun test

echo ""
echo "Publishing (${DRY_RUN:-LIVE})..."
echo ""

# Order matters: runtime first, then emitter (depends on runtime), then shims
for pkg in runtime emitter shim-bun shim-hono shim-node; do
  echo "--- @typespex/$pkg ---"
  (cd "packages/$pkg" && npm publish $DRY_RUN)
  echo ""
done

if [ -n "$DRY_RUN" ]; then
  echo "Dry run complete. Run with --run to actually publish."
else
  echo "All packages published."
fi
