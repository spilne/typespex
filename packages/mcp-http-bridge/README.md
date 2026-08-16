# `@typespex/mcp-http-bridge`

Executes generated TypeSpec HTTP operation plans behind MCP tools.

It owns upstream URL resolution, authentication alternatives, request serialization, response
classification, redirects, limits, and JSONL collection. It contains no MCP transport or framework
adapter code.

## Entry points

- `@typespex/mcp-http-bridge` exports bridge applications, providers, operation descriptors, and
  execution helpers.

## Runtime requirements

The package is ESM, targets ES2022, and requires Fetch, URL, Web Streams, Blob, and File APIs.
Node.js `>=22.12 <23` or `>=24 <25` is supported. Applications must install the matching
`@typespex/mcp-server` peer alongside this package.

## License

MIT
