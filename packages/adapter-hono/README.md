# `@typespex/adapter-hono`

An adapter from any Fetch `Request`/`Response` router to a Hono application or
middleware. Generated HTTP and MCP servers both satisfy the structural contract.

## Entry points

- `@typespex/adapter-hono` exports `toHonoApp` and `toHonoMiddleware`. Both
  accept the shared router contracts from `@typespex/http-server`.

Use the app adapter for a standalone generated service or the middleware
adapter to compose generated routes with an existing Hono application.
Unexpected errors raised while routing flow through Hono's `onError` handler.

## Runtime requirements

The package is ESM and targets ES2022. Node.js `>=22.12 <23` or `>=24 <25` is
required when running under Node. Hono `4.x` is a peer dependency. The adapter
does not install an HTTP or MCP server implementation.

## License

MIT
