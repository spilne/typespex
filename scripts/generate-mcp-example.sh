#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

output_dir=$(mktemp -d "example/.generated-mcp.tmp.XXXXXX")
backup_dir="${output_dir}.backup"

restore_generated() {
  local status=$?
  trap - EXIT
  set +e
  rm -rf "$output_dir"
  if [[ -e "$backup_dir" || -L "$backup_dir" ]]; then
    rm -rf example/generated-mcp
    mv "$backup_dir" example/generated-mcp
  fi
  exit "$status"
}
trap restore_generated EXIT

bun run --filter @typespex/codegen build
bun run --filter @typespex/mcp build
node example/node_modules/@typespec/compiler/cmd/tsp.js compile example/mcp-main.tsp \
  --config example/tspconfig.mcp.yaml \
  --output-dir "$output_dir"

if [[ -e example/generated-mcp || -L example/generated-mcp ]]; then
  mv example/generated-mcp "$backup_dir"
fi
mv "$output_dir" example/generated-mcp
trap - EXIT
rm -rf "$backup_dir"
