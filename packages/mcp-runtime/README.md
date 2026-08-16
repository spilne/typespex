# `@typespex/mcp-runtime`

Runtime support for `@typespex/mcp` generated servers. It adapts generated TypeSpec JSON Schemas and wire codecs to the MCP TypeScript SDK, provides typed handlers and middleware, and serves the same server factory over stdio or secure Streamable HTTP.

Normal applications should import generated APIs and only use this package for optional middleware, result helpers, transport configuration, and bridge providers.

## Entry points

- `@typespex/mcp-runtime` exposes typed applications, results, schemas, contexts, and server factories.
- `/stdio`, `/node`, `/bun`, and `/hono` expose transport launchers and mount adapters.
- `/http-bridge` exposes HTTP bridge descriptors, auth providers, and execution helpers.

## Runtime requirements

The package is ESM, targets ES2022, and supports Node.js `>=22.12 <23` or `>=24 <25`. It uses MCP
SDK v2 server packages and the standard Fetch, streams, Blob, and File APIs. Bun launchers require
Bun; framework mount adapters do not add Express or Hono as runtime dependencies.

## License

MIT
