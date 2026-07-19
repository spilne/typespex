# TypeSpex

TypeSpex turns TypeSpec HTTP services into type-safe TypeScript server contracts. The emitter
generates model types, request decoders, response encoders, handler interfaces, and a
framework-neutral router. Application code implements the generated interfaces and can run on
Bun, Node.js, or Hono without handling HTTP parsing in each operation.

The project is server-side only. It does not generate clients.

## How It Fits Together

```text
TypeSpec service
    -> @typespex/emitter
    -> generated TypeScript contracts and operations
    -> application handlers
    -> @typespex/runtime router
    -> Bun, Node.js, or Hono adapter
```

Request decoding and response encoding are generated from the TypeSpec HTTP contract. The
runtime matches routes, validates input, invokes middleware and handlers, and encodes the modeled
result as an HTTP response.

## Prerequisites

| Component | Supported version |
| --- | --- |
| Node.js for generation and builds | `>=20.19 <21` or `>=22.12` |
| TypeSpec compiler and `@typespec/http` | 1.x |
| TypeScript | `>=5.7 <6` |
| Bun | 1.3.13 is the repository CI baseline |
| Hono | 4.x |
| Module format | ESM |

Generated services use the standard Web APIs, including `Request`, `Response`, `Headers`,
`ReadableStream`, and `File`. TypeScript projects should use modern ESM settings such as
`module: "NodeNext"`, `moduleResolution: "NodeNext"`, and `target: "ES2022"`.

## Quickstart

Install the compiler, emitter, runtime, and one hosting adapter:

```sh
npm install @typespex/runtime
npm install --save-dev @typespec/compiler @typespec/http @typespex/emitter typescript

# Choose the adapter used by the service.
npm install @typespex/shim-bun
# npm install @typespex/shim-node
# npm install hono@^4 @typespex/shim-hono
```

### 1. Define the service

Create `main.tsp`:

```typespec
import "@typespec/http";

using TypeSpec.Http;

@service(#{ title: "Todos" })
namespace Todos {
  model Todo {
    id: string;

    @minLength(1)
    @maxLength(120)
    title: string;
  }

  model CreateTodoInput {
    @minLength(1)
    @maxLength(120)
    title: string;
  }

  @error
  model NotFoundError {
    @statusCode _: 404;
    code: "NOT_FOUND";
    message: string;
  }

  @route("/todos")
  interface Items {
    @get list(@minValue(1) @maxValue(100) @query limit?: int32): Todo[];
    @post create(@body body: CreateTodoInput): Todo;
    @get read(@path id: string): Todo | NotFoundError;
  }
}
```

### 2. Configure and run the emitter

Create `tspconfig.yaml`:

```yaml
emit:
  - "@typespex/emitter"
options:
  "@typespex/emitter":
    emitter-output-dir: "{output-dir}"
```

Compile the service:

```sh
npx tsp compile main.tsp --config tspconfig.yaml --output-dir src/generated
```

The default layout writes this service to `src/generated/todos/`.

### 3. Implement the typed handlers

Create `src/app.ts`:

```ts
import type { Todo } from "./generated/todos/models.js";
import type { TodosServer } from "./generated/todos/server.js";
import { createTodosServerRouter } from "./generated/todos/server-router.js";

const todos = new Map<string, Todo>();

const implementation: TodosServer = {
  Items: {
    async list({ limit }, ctx) {
      console.log(ctx.match.endpoint.operation.operationId);
      return [...todos.values()].slice(0, limit);
    },

    async create(input) {
      const todo = { id: crypto.randomUUID(), ...input };
      todos.set(todo.id, todo);
      return todo;
    },

    async read({ id }) {
      return todos.get(id) ?? {
        code: "NOT_FOUND" as const,
        message: `Todo ${id} was not found`,
      };
    },
  },
};

export const router = createTodosServerRouter(implementation);
```

Each handler is called with decoded input and a `MatchedRequestContext`; handlers may omit the
context parameter when it is unused. Its return type is the union of results declared by the
operation. Returning the `NotFoundError` value above produces a 404; the handler does not construct
a `Response`.

`createTodosServerRouter` also accepts `HttpInterpreterOptions`:

- `middleware` wraps matched handlers and the complete-router not-found handler.
- `createContext` can synchronously or asynchronously create a custom request context.
- `onUnhandledError` maps unexpected handler errors to a response.
- `notFound` replaces the default 404 response from `router.handle()`.

## Hosting Adapters

All adapters accept an optional structured `logger` with `error`, `warn`, and `info` methods.

### Bun

```ts
import { toBunHandler } from "@typespex/shim-bun";
import { router } from "./app.js";

const server = Bun.serve({
  port: 3000,
  ...toBunHandler(router),
});

console.log(`Listening on http://localhost:${server.port}`);
```

### Node.js

```ts
import { createServer } from "node:http";
import { toNodeHandler } from "@typespex/shim-node";
import { router } from "./app.js";

createServer(toNodeHandler(router)).listen(3000);
```

The Node adapter derives the request scheme from the socket by default. Set
`toNodeHandler(router, { trustProxy: true })` only when the process is directly behind a trusted
reverse proxy. That option trusts the first `X-Forwarded-Proto` value when reconstructing the URL.

### Hono

For a TypeSpex-only Hono application:

```ts
import { toHonoApp } from "@typespex/shim-hono";
import { router } from "./app.js";

export default toHonoApp(router);
```

To compose TypeSpex with user-defined Hono routes, register the TypeSpex middleware before the
routes that should handle unmatched requests:

```ts
import { Hono } from "hono";
import { toHonoMiddleware } from "@typespex/shim-hono";
import { router } from "./app.js";

const app = new Hono();

app.use("*", toHonoMiddleware(router));
app.get("/health", (c) => c.json({ status: "ok" }));

export default app;
```

`toHonoMiddleware` calls Hono's `next()` only when no TypeSpex operation matched. A response from a
matched operation, including a modeled 404, is terminal and does not fall through.

At the runtime level, `router.handle(request)` is the complete application and includes TypeSpex
middleware and not-found handling. `router.tryHandle(request)` returns `undefined` only when no
operation matched, which is useful when composing with other frameworks.

## Generated Files

The default `service-output: auto` layout creates one kebab-case directory per service:

| File | Purpose |
| --- | --- |
| `models.ts` | TypeScript model, enum, union, and scalar shapes, including referenced external namespace dependencies |
| `server-hints.ts` | Typed metadata keys emitted from supported TypeSpec decorators |
| `server-operations.ts` | Route metadata, request decoders, validators, and response encoders |
| `server.ts` | Typed operation-handler and service interfaces implemented by application code |
| `server-router.ts` | Factory that binds the implementation to the runtime router |

Generated files contain an `AUTO-GENERATED` header and should not be edited. Change the TypeSpec
source or emitter, then regenerate them. The emitter also supports `flat`, `prefix`, and
`directory` service layouts plus configurable service-folder and file-name patterns.

## HTTP and Error Behavior

TypeSpex decodes path, query, header, cookie, JSON, form, multipart, text, and binary input according
to the generated operation. Declared media types are checked before the handler runs. Constraints
such as `@minValue`, `@maxValue`, `@minLength`, `@maxLength`, and `@pattern` become runtime
validators.

Validation failures return status 400 with all applicable issues collected:

```json
{
  "error": "Invalid request",
  "issues": [
    {
      "path": "$body.title",
      "message": "Expected length greater than or equal to 1."
    }
  ]
}
```

An unsupported request `Content-Type` returns status 415 with the received and supported media
types. This check takes precedence because the body cannot be decoded safely.

The hosting adapters preserve stream-backed Web `Request` and `Response` bodies at their boundary.
Generated request body decoders nevertheless consume the complete body before invoking a handler,
including JSON, URL-encoded form, multipart, text, and binary bodies. TypeSpex does not impose an
application-specific body size limit or request deadline. Configure those limits in the trusted
reverse proxy, hosting runtime, or application middleware for the deployment environment.

Modeled success and error values are encoded using their declared status, headers, body, and media
type. Full-range `int64` and `uint64` handler values use `bigint` and are emitted as exact,
unquoted JSON numeric tokens; clients interpret those tokens according to their JSON number
implementation. Inbound JSON integer tokens longer than 20 digits are rejected before handler
decoding to bound precise-integer parsing. TypeSpec `bytes` map to `Uint8Array` and are base64
strings when nested in JSON.

Handlers and middleware may throw `HttpError` for an explicit HTTP response. Other exceptions use
`onUnhandledError` when configured, otherwise the router returns status 500. Unmatched requests
through `router.handle()` return `{"error":"Not Found"}` with status 404 unless `notFound` is
configured.

## Current Contract Boundaries

The emitter reports an error instead of generating a wire contract it cannot preserve. Current
diagnostics cover unsupported `@encode`, `@encodedName`, visibility decorators, `@discriminated`
union envelopes, and standard `@useAuth` metadata. They also reject parameter serialization
styles, media/body shape combinations, and output layouts that the generated runtime cannot
represent safely. Authentication and authorization enforcement should currently be implemented
in application middleware. Supported response bodies are JSON, `text/*`,
`application/octet-stream`, and empty responses.

## Regeneration

For an application, keep generation in a script and run it whenever the TypeSpec contract changes:

```sh
npx tsp compile main.tsp --config tspconfig.yaml --output-dir src/generated
```

In this repository, regenerate and verify the checked-in example with:

```sh
bun run generate:example
bun run check:generated
```

`check:generated` regenerates into a temporary directory and fails when the committed example is
stale.

## Contributing

Install the locked workspace dependencies:

```sh
bun install --frozen-lockfile
```

Run the same primary checks used by CI:

```sh
bun run build
bun run typecheck
bun test
bun run check:generated
```

The complete example is in [`example/`](./example), with its implementation in
[`example/server.ts`](./example/server.ts).

## License

[MIT](./LICENSE)
