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
not-found behavior. Errors handled inside the router use its configured error
behavior; anything that escapes the router boundary is logged and converted to
the Node adapter's standard 500 response. The handler ends the Express request
cycle and does not call `next()`.

TypeSpex decodes and validates bodies from the raw request stream. Register the
handler before `express.json()`, `express.urlencoded()`, or other middleware that
consumes that stream.

## Runtime requirements

The package is ESM and targets ES2022. Node.js `>=22.12 <23` or `>=24 <25` and
Express `5.x` are required. `@typespex/adapter-node` is installed as a regular
dependency; Express is a peer dependency. TypeScript
projects should install `@types/express` `5.x` as a development dependency.

## License

MIT
