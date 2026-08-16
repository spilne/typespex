# `@typespex/mcp`

TypeSpec decorators and an emitter for generating strongly typed Model Context Protocol servers.

```typespec
import "@typespex/mcp";

using TypeSpex.Mcp;

@mcpServer(#{ version: "1.0.0" })
namespace Example {
  @tool
  op greet(name: string): string;
}
```

Configure `@typespex/mcp` under `emit` and provide `application-module` whenever launchers are enabled. Generated applications depend on `@typespex/mcp-runtime`.
`mode` accepts a non-empty unique array: `[native]`, `[http-bridge]`, or
`[native, http-bridge]`. There is no special combined-mode string.

Bridge generation infers conservative tool annotations from HTTP verbs, with explicit `@tool`
values taking precedence; bridged tools are always open-world. Native-only generation has no HTTP
behavior to infer and therefore uses only explicit annotations.

## Entry points

- `@typespex/mcp` is both the TypeSpec library/emitter entry point and its JavaScript decorator export.
- The TypeSpec export is `lib/main.tsp`; compiler internals are intentionally not public.

## Runtime requirements

Generation requires TypeSpec `>=1.14 <2` and Node.js `>=22.12 <23` or `>=24 <25`. Native mode has
no `@typespec/http` requirement. Bridge and hybrid generation require aligned `@typespec/http`
1.14 or newer. Generated applications also install `@typespex/mcp-runtime`.

## License

MIT
