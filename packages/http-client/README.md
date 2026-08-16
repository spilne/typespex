# `@typespex/http-client`

Framework-neutral HTTP request execution for TypeSpex-generated clients and protocol bridges.

The package defines the data-only `HttpWireOperationPlan` contract and implements bounded Fetch
execution, redirect policy, response limits, and JSONL collection. Protocol emitters build
operation-specific serialization from the plan. This package contains no server or framework
adapter code.

Redirects are manual and bounded. Sensitive headers and configured query credentials are removed
on every redirect by default; applications may explicitly preserve sensitive headers for
same-origin redirects, while allowlisted cross-origin redirects always strip them. The optional
header timeout ends when response headers arrive. Body readers accept a separate cancellation
signal and cancel a stalled stream when it aborts. Redirects that would require replaying a
one-shot streaming request body fail explicitly.

## Entry points

- `@typespex/http-client` exports HTTP operation plans, Fetch policy primitives, and bounded body
  readers.

## Runtime requirements

The package is ESM, targets ES2022, and requires standard Fetch, URL, AbortSignal, and Web Streams
APIs. Node.js `>=22.12 <23` or `>=24 <25` is supported.

## License

MIT
