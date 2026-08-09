# `@typespex/runtime`

Framework-independent routing, request decoding, response encoding, middleware,
and operation primitives for TypeSpec-generated HTTP servers.

## Entry points

- `@typespex/runtime` exports the complete public runtime API.
- `@typespex/runtime/server` exports the framework-facing router and server API.

Generated services normally import this package directly. Choose one adapter
package to connect the router to a server framework.

## Runtime requirements

The package is ESM and targets ES2022. Node.js `>=22.12 <23` or `>=24 <25` is
required when running under Node. It uses the standard Fetch API request and
response types.

## License

MIT
