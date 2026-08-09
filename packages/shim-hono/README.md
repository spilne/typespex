# `@typespex/shim-hono`

An adapter from an `@typespex/runtime` HTTP router to a Hono application or
middleware.

## Entry points

- `@typespex/shim-hono` exports `toHonoApp` and `toHonoMiddleware`.

Use the app adapter for a standalone generated service or the middleware
adapter to compose generated routes with an existing Hono application.

## Runtime requirements

The package is ESM and targets ES2022. Node.js `>=22.12 <23` or `>=24 <25` is
required when running under Node. Hono `4.x` is a peer dependency;
`@typespex/runtime` is installed as a regular dependency.

## License

MIT
