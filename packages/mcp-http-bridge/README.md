# `@typespex/mcp-http-bridge`

Executes generated TypeSpec HTTP operation plans behind MCP tools.

It owns upstream URL resolution, authentication alternatives, request serialization, response
classification, redirects, limits, and JSONL collection. It contains no MCP transport or framework
adapter code.

HTTP union conversions preserve the matching variant's fields and reject incompatible alternative
conversions. Exact JSON types take precedence over lenient number/boolean parsing or scalar-to-array
wrapping: `int32 | string` preserves `"42"` as a string, and `T | T[]` preserves a single object.
Explicit encodings can still overlap (for example, string-encoded numbers and plain strings);
use object variants with distinct literal discriminators to make their meaning unambiguous.
Additional properties cannot bypass or overwrite declared fields when HTTP and MCP names differ.

## Entry points

- `@typespex/mcp-http-bridge` exports bridge applications, providers, operation descriptors, and
  execution helpers.

## Runtime requirements

The package is ESM, targets ES2022, and requires Fetch, URL, Web Streams, Blob, and File APIs.
Node.js `>=22.12 <23` or `>=24 <25` is supported. Applications must install the matching
`@typespex/mcp-server` peer alongside this package.

## Operational errors

HTTP request and response-reading failures become `McpToolError` instances. The bridge selects
their messages from `HttpClientError.code`, independently of the HTTP client's diagnostic
wording. The original error is retained as `cause` for application-side inspection; its message
is not copied into the tool result. Existing `McpToolError` instances are preserved.

Limit and redirect messages describe the policy failure without embedding the configured bound
or rejected origin. Authentication, redirect policies, cancellation, and result shapes are unchanged.

## License

MIT
