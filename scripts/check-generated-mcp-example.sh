#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -d example/generated-mcp ]]; then
  printf 'Generated MCP example is missing. Run `bun run generate:mcp-example`.\n' >&2
  exit 1
fi

output_dir=$(mktemp -d "${TMPDIR:-/tmp}/typespex-generated-mcp.XXXXXX")
trap 'rm -rf "$output_dir"' EXIT

node example/node_modules/@typespec/compiler/cmd/tsp.js compile example/mcp-main.tsp \
  --config example/tspconfig.mcp.yaml \
  --output-dir "$output_dir" \
  >/dev/null

if diff -ru example/generated-mcp "$output_dir"; then
  exit 0
else
  diff_status=$?
fi

if ((diff_status == 1)); then
  printf '\nGenerated MCP example is stale. Run `bun run generate:mcp-example`.\n' >&2
else
  printf '\nFailed to compare generated MCP output (diff exited %d).\n' "$diff_status" >&2
fi
exit "$diff_status"
