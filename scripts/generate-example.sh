#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

output_dir=$(mktemp -d "example/.generated.tmp.XXXXXX")
backup_dir="${output_dir}.backup"

restore_generated() {
  local status=$?
  trap - EXIT
  set +e
  rm -rf "$output_dir"
  if [[ -e "$backup_dir" || -L "$backup_dir" ]]; then
    rm -rf example/generated
    mv "$backup_dir" example/generated
  fi
  exit "$status"
}
trap restore_generated EXIT

bun run --filter @typespex/emitter build
node example/node_modules/@typespec/compiler/cmd/tsp.js compile example/main.tsp \
  --config example/tspconfig.yaml \
  --output-dir "$output_dir"

if [[ -e example/generated || -L example/generated ]]; then
  mv example/generated "$backup_dir"
fi
mv "$output_dir" example/generated
trap - EXIT
rm -rf "$backup_dir"
