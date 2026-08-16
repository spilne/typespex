# `@typespex/mcp-transport-stdio`

Protocol-clean stdio transport for TypeSpex MCP server factories.

It delegates protocol handling to MCP SDK v2 and routes default diagnostics to stderr so stdout
contains MCP frames only.

## Entry points

- `@typespex/mcp-transport-stdio` exports `serveMcpStdio` and its options.

## Runtime requirements

The package is ESM, targets ES2022, requires the MCP SDK v2 server package, and supports Node.js
`>=22.12 <23` or `>=24 <25`.

## License

MIT
