# `@typespex/adapter-node`

An adapter from an `@typespex/http-server` HTTP router to a Node.js
`http.createServer` request handler.

## Entry points

- `@typespex/adapter-node` exports `toNodeHandler`.

The adapter bridges Node request and response streams to the standard Fetch API
types used by the runtime.

## Runtime requirements

The package is ESM and targets ES2022. Node.js `>=22.12 <23` or `>=24 <25` is
required. `@typespex/http-server` is installed as a regular dependency.

## License

MIT
