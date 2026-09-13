# `@typespex/codec`

Protocol-neutral codecs used by TypeSpex-generated applications to convert between validated wire values and semantic TypeScript values.

The package owns encoded names, defaults, dates, bytes, files, and lossless numeric transforms. It has no HTTP, MCP, CLI, framework, or transport behavior.

Generated numeric codecs can carry exact decimal bounds in `numericConstraints`. They check both
wire and semantic values during conversion, including string encodings that JSON Schema numeric
keywords cannot validate. Comparisons preserve integer and decimal precision without expanding
large exponents.

Union conversion prefers branches that preserve the supplied object fields. If matching branches
produce different semantic or wire values, conversion reports an ambiguity instead of dropping
fields according to declaration order. Use a discriminator when alternatives have incompatible
interpretations. Equivalent alternatives remain valid, including bytes, dates, and files.

Ambiguous cases include `string | bytes` for valid base64, `string | utcDateTime` in Date or
Temporal mode for date-like strings, and object variants that supply different defaults for the
same omitted property. A wider handler object also fails when removing its extra fields would
produce different valid projections. Wrap overlapping scalars in objects with distinct literal
discriminators, or return the precise declared object shape. A nested conversion failure never
falls back to dropping that declared field when a branch covers the supplied fields. If no exact
branch accepts those declared values, conversion can fail even when dropping fields into a different
shape would validate. Defaults are decoded independently for each item.

A union branch can carry a `wireSchema` fragment. Pass `validateWire` in `createValueCodec` options
to resolve and validate those fragments against their containing JSON Schema document; the MCP
runtime supplies this callback automatically. Standalone codecs without a callback only check
structure and supported scalar constraints. The codec's `validateWire` method preserves valid wire
values without requiring a unique semantic interpretation; `decode` still requires one.

## Entry points

- `@typespex/codec` exports codec plan types, `createValueCodec`, `bytesToBase64`, and the
  `ScalarEncodings` helpers and scalar wire-encoding types.

## Runtime requirements

The package is ESM, targets ES2022, and uses standard Web APIs. Node.js `>=22.12 <23` or
`>=24 <25` is supported. `@js-temporal/polyfill` is an optional peer used only for Temporal
representations when `globalThis.Temporal` is unavailable.

## License

MIT
