# `@typespex/adapter-bun`

Connects a Fetch `Request`/`Response` router to Bun, as a standalone HTTP server
or a fetch handler. Generated HTTP and MCP servers both satisfy the structural contract.

## Entry points

- `@typespex/adapter-bun` exports `toBunHandler` and `BunHandlerOptions`.
- `@typespex/adapter-bun/server` exports `createBunServer`, `BunServerOptions`, and `BunHttpServer`.

For a standalone server:

```ts
import { createBunServer } from "@typespex/adapter-bun/server";
import { router } from "./app.js";

const server = createBunServer(router, { port: 3000 });
console.log(`Listening on ${server.url}`);
// await server.stop();
```

The standalone server uses native Bun routes for tables composed of literal segments and
whole-segment parameters without request-selection constraints. Other tables and custom matchers
use the router's normal dispatch. Both paths preserve middleware, authorization wrappers,
validation, exact route matching, and request-body limits. Fixed-length bodies retain native
buffering; chunked bodies retain streamed byte counting.

The returned handle exposes listening addresses, pending request counts, `stop`, `ref`, `unref`,
`requestIP`, and `timeout`. Bun's synthetic `fetch` and `reload` entry points stay private so
native request provenance is established once at server creation. Use `router.handle(request)`
for direct request tests. The `maxRequestBodySize` option adds Bun's own transport cap, which can
reject a request before the router runs. Unexpected failures use Bun's error handler and the
configured logger; use the router's `onUnhandledError` when logging needs request context.
The standalone server disables Bun's development error pages.

TypeScript consumers of `/server` should install the optional `@types/bun` peer. The default
Fetch adapter entry point does not load Bun's global types.

For an existing Bun server or direct access to Bun's full server API, use `toBunHandler`:

Pass the returned `fetch` handler to `Bun.serve`. It accepts the shared
`HttpRouter` and `Logger` contracts from `@typespex/http-server` and converts
unexpected failures to a logged 500 response.

When used directly by `Bun.serve`, the adapter preserves native buffering for
fixed-length request bodies while enforcing the router's configured byte limit.
Chunked bodies and synthetic requests retain streamed byte counting. Custom routers
and wrappers continue through their ordinary `handle(request)` method.

The optional second `fetch` argument is reserved for Bun's native callback with
an unmodified request. For manual calls, or wrappers that rewrite request
headers, call `handler.fetch(request)` without that argument.

## Runtime requirements

The package is ESM and targets ES2022. Bun 1.3.14 is the tested baseline.
Node-based build tooling requires Node.js `>=22.12 <23` or `>=24 <25`.
The adapter does not install an HTTP or MCP server implementation.

## License

MIT
