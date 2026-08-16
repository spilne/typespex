# `@typespex/mcp-emitter`

Compiles the `@typespex/mcp` vocabulary into typed MCP server artifacts.

It owns MCP service discovery, tool diagnostics, JSON Schema generation, application contracts,
and optional launcher emission. Library-only generation is the default; launchers are selected
explicitly.

## Entry points

- `@typespex/mcp-emitter` exports the TypeSpec emitter and its options.

## Runtime requirements

The emitter requires TypeSpec `>=1.14 <2` and Node.js `>=22.12 <23` or `>=24 <25`.

## License

MIT
