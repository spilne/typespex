# Contributing to TypeSpex

Thank you for improving TypeSpex. Contributions should preserve the TypeSpec contract at every
generated and runtime boundary rather than adding framework-specific behavior to application code.

## Before opening an issue

- Search existing issues and pull requests for the same behavior.
- Report security concerns through the process in [SECURITY.md](SECURITY.md), not a public issue.
- Reduce bug reports to the smallest TypeSpec service and request that demonstrate the problem.
- Replace credentials, tokens, private URLs, personal paths, usernames, and customer data with
  obvious placeholders. Do not paste an entire environment, shell history, or process environment.

## Development setup

The repository uses the Bun version declared by `packageManager` in `package.json`.

```sh
git clone https://github.com/spilne/typespex.git
cd typespex
bun install --frozen-lockfile
bun run build
bun run test
```

The packages form one workspace. Emitter changes commonly require corresponding runtime behavior,
generated-output assertions, and an end-to-end route test.

## Pull requests

- Keep each pull request focused on one independently reviewable change.
- Explain the observable problem, root cause, and compatibility impact.
- Add regression coverage that fails without the change.
- Preserve explicit diagnostics for TypeSpec features that cannot be represented safely.
- Avoid unrelated formatting, dependency, generated-file, or documentation churn.
- Do not create tags, publish packages, or modify release automation as part of an ordinary change.

Run the relevant focused tests while developing. Before requesting merge, run the complete local
quality gates when the change can affect generated or runtime behavior:

```sh
bun run format:check
bun run build
bun run typecheck
bun run check:generated
bun run check:conformance
bun run test
bun run test:coverage
bun run check:packages
bun run audit:dependencies
```

`check:packages` validates packed artifacts in a clean consumer but never publishes them.

## Generated files

Use `bun run generate:example` to update the checked-in example after emitter behavior changes. Do
not hand-edit files below `example/generated/`. Temporary coverage, benchmark, audit, and review
artifacts belong below `.context/`, which is ignored by Git.

## Compatibility

Supported runtime, Node.js, TypeScript, and TypeSpec ranges are documented in the README. A change
that intentionally narrows compatibility must update the policy and CI matrix in the same pull
request. New TypeSpec HTTP behavior should be checked against the pinned upstream conformance
scenarios as well as a focused local regression test.
