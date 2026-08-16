# Releasing Typespex

All publishable packages use the same version and are released from a matching
`v<version>` tag. The release workflow pins the repository's Bun version,
installs the frozen lockfile, and invokes the canonical package command:

```sh
bun run publish:packages -- --tag v0.1.1 --provenance
```

The command checks that the tag matches every package and that none of those
versions already exists in the registry. It then runs the build, typecheck,
generated-output check, test suite, and Node adapter smoke test. Only after all
quality gates pass does it pack every package with `bun pm pack`, verify the
tarballs and usable source maps (embedded JavaScript sources and packaged
declaration sources), and install and import the complete package set in a clean
npm consumer.

All packages are packed before the first registry write. Publication order follows the explicit
public dependency graph: codec, HTTP client, compiler core, HTTP server, MCP vocabulary, MCP server,
MCP HTTP bridge, MCP HTTP transport, MCP stdio transport, HTTP emitter, MCP emitter, Bun adapter,
Hono adapter, Node adapter, then Express adapter.

## Local preflight

Run the same gates without registry writes:

```sh
bun run release:preflight -- --tag v0.1.1
```

Pass `--output-dir .release-packages` to keep the validated tarballs for
inspection. The directory must be empty.

## Recovering from a partial publication

Package versions are immutable. If a registry request fails during the
sequential publish:

1. Inspect every expected version with `npm view <name>@<version>`. A failed
   client request may still have reached the registry.
2. Keep the validated artifact directory printed by the release command.
3. Do not retry a version already accepted by the registry. If all accepted
   artifacts are correct, publish only the remaining preflighted tarballs in
   the documented dependency order.
4. If the exact artifact state is uncertain, stop. Bump every package to a new
   version and create a matching new tag instead of trying to overwrite or
   reuse a published version.
