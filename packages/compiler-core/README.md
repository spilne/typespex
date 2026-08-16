# `@typespex/compiler-core`

Protocol-neutral TypeSpec planning utilities shared by TypeSpex emitters.

The package is published so independently installed emitters can share one compiler plan, but its compiler-author API remains explicitly unstable until the HTTP and CLI emitters migrate to it. Application code should not depend on this package.

Import compiler-author APIs from `@typespex/compiler-core/unstable`.

## Entry points

- `@typespex/compiler-core` exposes the compiler plan-format version.
- `@typespex/compiler-core/unstable` exposes compiler-author planning, naming, schema, layout, and atomic artifact utilities.

## Runtime requirements

The package is ESM, targets ES2022, and supports Node.js `>=22.12 <23` or `>=24 <25`. It accepts
TypeSpec compiler `>=1.14 <2`.

## License

MIT
