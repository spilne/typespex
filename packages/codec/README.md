# `@typespex/codec`

Protocol-neutral codecs used by TypeSpex-generated applications to convert between validated wire values and semantic TypeScript values.

The package owns encoded names, defaults, dates, bytes, files, and lossless numeric transforms. It has no HTTP, MCP, CLI, framework, or transport behavior.

Generated numeric codecs can carry exact decimal bounds in `numericConstraints`. They check both
wire and semantic values during conversion, including string encodings that JSON Schema numeric
keywords cannot validate. Comparisons preserve integer and decimal precision without expanding
large exponents.

## Entry points

- `@typespex/codec` exports codec plan types, `createValueCodec`, `bytesToBase64`, and the
  `ScalarEncodings` helpers and scalar wire-encoding types.

## Runtime requirements

The package is ESM, targets ES2022, and uses standard Web APIs. Node.js `>=22.12 <23` or
`>=24 <25` is supported. `@js-temporal/polyfill` is an optional peer used only for Temporal
representations when `globalThis.Temporal` is unavailable.

## License

MIT
