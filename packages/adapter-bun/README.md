# `@typespex/adapter-bun`

An adapter from any Fetch `Request`/`Response` router to a Bun server fetch
handler. Generated HTTP and MCP servers both satisfy the structural contract.

## Entry points

- `@typespex/adapter-bun` exports `toBunHandler` and `BunHandlerOptions`.

Pass the returned `fetch` handler to `Bun.serve`. It accepts the shared
`HttpRouter` and `Logger` contracts from `@typespex/http-server` and converts
unexpected failures to a logged 500 response.

When used directly by `Bun.serve`, the adapter preserves native buffering for
fixed-length request bodies while enforcing the router's configured byte limit.
Chunked bodies and synthetic requests retain streamed byte counting.

The optional second `fetch` argument is reserved for Bun's native callback with
an unmodified request. For manual calls, or wrappers that rewrite request
headers, call `handler.fetch(request)` without that argument.

## Runtime requirements

The package is ESM and targets ES2022. Bun 1.3.14 is the tested baseline.
Node-based build tooling requires Node.js `>=22.12 <23` or `>=24 <25`.
The adapter does not install an HTTP or MCP server implementation.

## License

MIT
