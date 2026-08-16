# `@typespex/adapter-hono`

An adapter from an `@typespex/http-server` HTTP router to a Hono application or
middleware.

## Entry points

- `@typespex/adapter-hono` exports `toHonoApp` and `toHonoMiddleware`.

Use the app adapter for a standalone generated service or the middleware
adapter to compose generated routes with an existing Hono application.

## Runtime requirements

The package is ESM and targets ES2022. Node.js `>=22.12 <23` or `>=24 <25` is
required when running under Node. Hono `4.x` is a peer dependency;
`@typespex/http-server` is installed as a regular dependency.

## License

MIT
