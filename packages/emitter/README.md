# `@typespex/emitter`

A TypeSpec emitter that generates strongly typed TypeScript HTTP server
bindings backed by `@typespex/runtime`.

## Entry points

- `@typespex/emitter` exports the TypeSpec emitter and its library definition.

Configure the package as an emitter in `tspconfig.yaml`. Generated files import
`@typespex/runtime`, which must be installed by the generated service.

## Options

`datetime-mode` controls handler-facing date and duration types:

- `string` (default) maps `plainDate`, `plainTime`, `utcDateTime`, `offsetDateTime`, and `duration`
  to `string`.
- `date` maps `utcDateTime` and `offsetDateTime` to `Date`; the other three remain strings. Offsets
  are normalized to UTC and precision is limited to milliseconds.
- `temporal` maps the five scalars to `Temporal.PlainDate`, `Temporal.PlainTime`,
  `Temporal.Instant`, `Temporal.ZonedDateTime`, and `Temporal.Duration`, respectively. Generated
  services using this mode must install `@js-temporal/polyfill`. RFC 3339 unknown-offset and
  leap-second wire values are rejected because Temporal cannot preserve those representations.

The layout options are `service-output`, `service-folder-pattern`, and `file-name-pattern`. See the
repository README for the mapping table and complete configuration examples.

## Runtime requirements

The package is ESM and targets ES2022. Node.js `>=22.12 <23` or `>=24 <25` is
required. Compatible releases from 1.0.0 through the latest 1.x versions of
`@typespec/compiler` and `@typespec/http` are peer dependencies.

## License

MIT
