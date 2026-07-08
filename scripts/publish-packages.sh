#!/usr/bin/env bash
set -euo pipefail

# Build and publish all packages in dependency order (runtime first,
# then the packages that depend on it). Extra arguments are forwarded
# to `npm publish` (e.g. --provenance in CI, --dry-run locally).
#
# `bun pm pack` is used instead of publishing the workspace directly
# because it resolves workspace:* dependencies to real versions;
# `npm publish` on the workspace would ship the literal "workspace:*".

cd "$(dirname "$0")/.."

bun run build

for pkg in runtime emitter shim-bun shim-hono shim-node; do
  (
    cd "packages/$pkg"
    tarball=$(bun pm pack --quiet | tail -n1)
    npm publish "$tarball" --access public "$@"
    rm -f "$tarball"
  )
done
