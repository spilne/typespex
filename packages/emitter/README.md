# `@typespex/emitter`

A TypeSpec emitter that generates strongly typed TypeScript HTTP server
bindings backed by `@typespex/runtime`.

## Entry points

- `@typespex/emitter` exports the TypeSpec emitter and its library definition.

Configure the package as an emitter in `tspconfig.yaml`. Generated files import
`@typespex/runtime`, which must be installed by the generated service.

## Runtime requirements

The package is ESM and targets ES2022. Node.js `>=22.12 <23` or `>=24 <25` is
required. Compatible releases from 1.0.0 through the latest 1.x versions of
`@typespec/compiler` and `@typespec/http` are peer dependencies.

## License

MIT
