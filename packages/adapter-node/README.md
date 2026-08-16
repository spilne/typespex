# `@typespex/adapter-node`

An adapter from any Fetch `Request`/`Response` router to a Node.js
`http.createServer` request handler. Generated HTTP and MCP servers both satisfy
the structural router contract.

## Entry points

- `@typespex/adapter-node` exports `toNodeHandler` and its small structural
  router, logger, and option types.

The adapter bridges Node request and response streams to the standard Fetch API
types used by the runtime.

## Runtime requirements

The package is ESM and targets ES2022. Node.js `>=22.12 <23` or `>=24 <25` is
required. The adapter does not install an HTTP or MCP server implementation.

## License

MIT
