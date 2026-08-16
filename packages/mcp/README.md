# `@typespex/mcp`

TypeSpec vocabulary for declaring Model Context Protocol servers and tools.

```typespec
import "@typespex/mcp";

using TypeSpex.Mcp;

@mcpServer(#{ version: "1.0.0", instructions: "Manage pets" })
namespace PetStore {
  @tool(#{ title: "Get pet", annotations: #{ readOnlyHint: true } })
  op getPet(id: string): Pet | NotFoundError;
}
```

`@mcpServer` declares a server root. `@tool` is opt-in: undecorated operations
are never exposed. The package records decorator metadata only; generation is
owned by `@typespex/mcp-emitter`.

## Entry points

- The `@typespex/mcp` TypeSpec export provides `TypeSpex.Mcp`, `@mcpServer`, and
  `@tool`.
- The JavaScript export provides decorator metadata readers for compiler
  authors.

## Runtime requirements

The package is ESM, targets ES2022, and accepts TypeSpec `>=1.14 <2`. It has no
MCP SDK, transport, HTTP, or framework dependency.

## License

MIT
