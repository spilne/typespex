# `@typespex/shim-bun`

An adapter from an `@typespex/runtime` HTTP router to a Bun server fetch
handler.

## Entry points

- `@typespex/shim-bun` exports `toBunHandler`.

Pass the returned `fetch` handler to `Bun.serve`.

## Runtime requirements

The package is ESM and targets ES2022. Bun 1.3.14 is the tested baseline.
Node-based build tooling requires Node.js `>=22.12 <23` or `>=24 <25`.
`@typespex/runtime` is installed as a regular dependency.

## License

MIT
