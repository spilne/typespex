# `@typespex/mcp-emitter`

Compiles the `@typespex/mcp` vocabulary into typed MCP server artifacts.

It owns MCP service discovery, tool diagnostics, JSON Schema generation, application contracts,
and optional launcher emission. Library-only generation is the default; launchers are selected
explicitly.

## Entry points

- `@typespex/mcp-emitter` exports the TypeSpec emitter and its options.

## Runtime requirements

The emitter requires `@typespec/compiler >=1.14 <2` and Node.js `>=22.12 <23` or `>=24 <25`.
HTTP bridge mode additionally requires the aligned `@typespec/http` release. Install the aligned
`@typespec/streams` release when a specification uses TypeSpec stream models; the emitter uses its
metadata to reject native streams and plan supported HTTP JSONL streams.

Generated applications using `datetime-mode: temporal` must install `@js-temporal/polyfill` unless
they provide a compatible `globalThis.Temporal` implementation.

Numeric contracts retain intrinsic, inherited, and property bounds when encoded as strings.
Generated runtime checks enforce these bounds for tool inputs, native outputs, and HTTP bridge
outputs. If TypeSpec resolves a numeric literal written directly in a bound decorator with lost
precision, generation reports a diagnostic instead of emitting an incorrect bound. This check does
not currently detect precision loss through `const` references or custom decorators. Numeric defaults
that violate declared bounds also produce a generation diagnostic, including nested object defaults.

## License

MIT
