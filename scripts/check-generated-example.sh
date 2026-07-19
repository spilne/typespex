#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -d example/generated ]]; then
  printf 'Generated example is missing. Run `bun run generate:example`.\n' >&2
  exit 1
fi

output_dir=$(mktemp -d "${TMPDIR:-/tmp}/typespex-generated.XXXXXX")
trap 'rm -rf "$output_dir"' EXIT

node example/node_modules/@typespec/compiler/cmd/tsp.js compile example/main.tsp \
  --config example/tspconfig.yaml \
  --output-dir "$output_dir" \
  >/dev/null

if diff -ru example/generated "$output_dir"; then
  exit 0
else
  diff_status=$?
fi

if ((diff_status == 1)); then
  printf '\nGenerated example is stale. Run `bun run generate:example`.\n' >&2
else
  printf '\nFailed to compare generated output (diff exited %d).\n' "$diff_status" >&2
fi
exit "$diff_status"
