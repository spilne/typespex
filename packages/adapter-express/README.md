# `@typespex/adapter-express`

An adapter from any Fetch `Request`/`Response` router to an Express request handler.
Generated HTTP and MCP servers both satisfy the structural contract.

## Entry points

- `@typespex/adapter-express` exports `toExpressHandler`, `ExpressRequestHandler`, and
  `ExpressHandlerOptions`.

Mount the returned terminal handler where the generated service should own the
request path:

```ts
import express from "express";
import { toExpressHandler } from "@typespex/adapter-express";

const app = express();
app.use("/api", toExpressHandler(router));
app.listen(3000);
```

The handler delegates unmatched requests to the generated router's configured
not-found behavior. Expected HTTP errors remain responses; unexpected failures
raised before the response starts are passed to Express error middleware with
`next(error)`. If a response stream fails after headers are sent, the connection
is closed instead. The handler calls `next()` only for delegable failures, not
for unmatched routes.

TypeSpex decodes and validates bodies from the raw request stream. Register the
handler before `express.json()`, `express.urlencoded()`, or other middleware that
consumes that stream.

## Runtime requirements

The package is ESM and targets ES2022. Node.js `>=22.12 <23` or `>=24 <25` and
Express `5.x` are required. `@typespex/adapter-node` and `@typespex/http-server`
are installed as regular dependencies; Express is a peer dependency. TypeScript
projects should install `@types/express` `5.x` as a development dependency.

## License

MIT
