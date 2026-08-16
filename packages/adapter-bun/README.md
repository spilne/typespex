# `@typespex/adapter-bun`

An adapter from any Fetch `Request`/`Response` router to a Bun server fetch
handler. Generated HTTP and MCP servers both satisfy the structural contract.

## Entry points

- `@typespex/adapter-bun` exports `toBunHandler` and `BunHandlerOptions`.

Pass the returned `fetch` handler to `Bun.serve`. It accepts the shared
`HttpRouter` and `Logger` contracts from `@typespex/http-server` and converts
unexpected failures to a logged 500 response.

## Runtime requirements

The package is ESM and targets ES2022. Bun 1.3.14 is the tested baseline.
Node-based build tooling requires Node.js `>=22.12 <23` or `>=24 <25`.
The adapter does not install an HTTP or MCP server implementation.

## License

MIT
