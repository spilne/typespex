# `@typespex/adapter-node`

An adapter from any Fetch `Request`/`Response` router to a Node.js
`http.createServer` request handler. Generated HTTP and MCP servers both satisfy
the structural router contract.

## Entry points

- `@typespex/adapter-node` exports `toNodeHandler` and `NodeHandlerOptions`.

The handler accepts the shared `HttpRouter` and `Logger` contracts from
`@typespex/http-server`. Unexpected failures become a logged 500 response by
default. Set `errorMode: "throw"` when embedding it in a host framework with
its own error boundary. Only failures raised before the response starts can be
delegated; a failure after headers or body bytes are written closes the
connection because no error handler can safely replace that response.

The adapter bridges Node request and response streams to the standard Fetch API
types used by the runtime.

## Runtime requirements

The package is ESM and targets ES2022. Node.js `>=22.12 <23` or `>=24 <25` is
required. The adapter does not install an HTTP or MCP server implementation.

## License

MIT
