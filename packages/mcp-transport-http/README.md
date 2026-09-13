# `@typespex/mcp-transport-http`

Fetch-native Streamable HTTP transport and security policy for TypeSpex MCP servers.

It validates mount paths, Host and Origin, enforces authentication for non-loopback exposure, and
wraps MCP SDK v2 HTTP handlers. Node, Bun, Express, and Hono integration stays in the existing
`@typespex/adapter-*` packages so consumers install only their chosen runtime.

When `verifyAuth` is supplied, every request must pass it, including loopback requests. Returning
`undefined` rejects the request with HTTP 401; returning a `Response` uses that response directly.
Loopback servers without a verifier continue to allow anonymous requests.

## Entry points

- `@typespex/mcp-transport-http` exports `createMcpHttpHandler`, HTTP server options, and their
  security-policy resolver.

## Runtime requirements

The package is ESM, targets ES2022, and requires the MCP SDK v2 server package plus Fetch APIs.
Node.js `>=22.12 <23` or `>=24 <25` is supported.

## License

MIT
