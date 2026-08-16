# `@typespex/http-server`

Framework-independent routing, request decoding, response encoding, middleware,
and operation primitives for TypeSpec-generated HTTP servers.

## Entry points

- `@typespex/http-server` exports the complete router and server API.

Generated services normally import this package directly. Choose one adapter
package to connect the router to a server framework.

## XML payloads

Generated XML operations use `XmlCodec` values to decode and encode the same TypeSpec model.
The codecs support encoded element names, attributes, wrapped and unwrapped arrays, unwrapped text,
records, and namespace-qualified elements. Requests are matched by namespace URI rather than a
specific client prefix. XML document type declarations are rejected, and malformed documents are
returned as request validation errors. Predefined and numeric character references are accepted;
undeclared named entities are rejected. Handler serialization failures raise `XmlSerializationError`
with the failing response path.

## JSONL streams

`decodeJsonlBody` validates the request boundary immediately and returns a single-use
`AsyncIterable` that decodes UTF-8 JSON records on demand. JSON syntax, item validation, and
streamed body-limit failures surface during iteration, so handlers must consume or close the
iterable before returning. `ResponseEncoders.jsonl` performs the inverse operation for response
streams while honoring downstream backpressure.

## Server-sent event streams

`ResponseEncoders.sse` converts an `AsyncIterable` into a `text/event-stream` response. Its event
transform returns serialized `data`, an optional named `event`, and an optional `terminal` marker.
The encoder normalizes multiline data into individual `data:` fields, honors downstream
backpressure, and closes the source iterator after cancellation, failure, or a terminal event.

## Shared-route matching

The built-in regex and radix matchers accept a `selection` on structurally duplicate route inputs.
Every duplicate pair must contain a non-overlapping constraint for the same required header;
otherwise matcher construction throws a conflict error that includes both paths and optional route
labels. Pass request headers as the third argument to `matcher.match(...)`. Generated TypeSpex
routers configure and pass these selectors automatically for supported TypeSpec `@sharedRoute`
operations.

## Runtime requirements

The package is ESM and targets ES2022. Node.js `>=22.12 <23` or `>=24 <25` is
required when running under Node. It uses the standard Fetch API request and
response types.

## License

MIT
