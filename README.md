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

| Component                              | Supported version                    |
| -------------------------------------- | ------------------------------------ |
| Node.js for generation and builds      | `>=22.12 <23` or `>=24 <25`          |
| TypeSpec compiler and `@typespec/http` | `>=1.0.0 <2.0.0`                     |
| TypeScript                             | `>=5.7 <6`                           |
| Bun                                    | 1.3.13 is the repository CI baseline |
| Hono                                   | 4.x                                  |
| Module format                          | ESM                                  |

Generated services use the standard Web APIs, including `Request`, `Response`, `Headers`,
`ReadableStream`, and `File`. TypeScript projects should use modern ESM settings such as
`module: "NodeNext"`, `moduleResolution: "NodeNext"`, and `target: "ES2022"`.

### Compatibility policy

The TypeSpec compatibility job tests `@typespec/compiler` and `@typespec/http` as an aligned pair.
It covers the declared minimum, 1.0.0, and resolves the newest stable 1.x version published by both
packages on every run. Each pair must build the emitter, compile the representative service in
`example/`, and typecheck its generated TypeScript.

Node.js support follows maintained LTS lines. CI exercises the runtime and Node adapter on the
oldest supported version, 22.12.0, and the current supported 24.x line. A future Node major is
added to `engines` only after it reaches LTS and has equivalent CI coverage; an end-of-life line is
removed during the next compatibility review. The ranges and matrix are reviewed at each Node LTS
transition, while new stable TypeSpec 1.x releases enter the dynamic compatibility job
automatically.

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
      return (
        todos.get(id) ?? {
          code: "NOT_FOUND" as const,
          message: `Todo ${id} was not found`,
        }
      );
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

| File                   | Purpose                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `models.ts`            | TypeScript model, enum, union, and scalar shapes, including referenced external namespace dependencies |
| `server-hints.ts`      | Typed metadata keys emitted from supported TypeSpec decorators                                         |
| `server-operations.ts` | Route metadata, request decoders, validators, and response encoders                                    |
| `server.ts`            | Typed operation-handler and service interfaces implemented by application code                         |
| `server-router.ts`     | Factory that binds the implementation to the runtime router                                            |

Generated files contain an `AUTO-GENERATED` header and should not be edited. Change the TypeSpec
source or emitter, then regenerate them. The emitter also supports `flat`, `prefix`, and
`directory` service layouts plus configurable service-folder and file-name patterns.

## HTTP and Error Behavior

TypeSpex decodes path, query, header, cookie, JSON, form, multipart, text, binary, and raw file
input according to the generated operation. Declared media types are checked before the handler
runs. Constraints such as `@minValue`, `@maxValue`, `@minLength`, `@maxLength`, and `@pattern`
become runtime validators.

Multipart requests are decoded from their raw MIME representation. Model-shaped
`multipart/form-data` and `multipart/mixed` bodies match each wire part name to its TypeSpec
source property, while tuple-shaped bodies preserve declaration order and support unnamed
`multipart/mixed` parts. Text, JSON, binary, and `File` parts retain their per-part media types;
optional and repeated parts keep their declared handler shape. Malformed boundaries, headers,
missing required parts, unexpected parts, and ambiguous tuple cardinality are returned as
structured request validation errors.

Request models follow TypeSpec's open-object convention. Undeclared properties on an ordinary
model are accepted but omitted from the typed handler value. A model that spreads, copies, or
extends `Record<T>` instead validates and preserves undeclared properties as `T`; its declared
properties keep their own types and requiredness. `Record<never>` explicitly seals a model and
rejects undeclared properties. TypeScript requires declared fields to be assignable to a string
index signature, so a mixed model's generated index value is widened with its declared field types
when necessary; runtime validation still applies `T` to undeclared fields.

JSON payloads honor `@encodedName("application/json", ...)` recursively. Generated request
decoders read the encoded wire key but expose the original TypeSpec property name to handlers;
response serializers perform the inverse mapping. The transform applies through nested models,
arrays, records, optional properties, nullable properties, and recursive models, including
structured `+json` media types. Request validation paths use wire names. A malformed handler
result raises a path-aware `JsonSerializationError` before an invalid JSON body is returned.

A TypeSpec HTTP `File` used as a raw body or multipart part is represented by the Web `File`
type. Its `type`, `name`, and blob contents carry the media type, filename, and bytes. A missing
`Content-Type` is accepted when the file's `contentType` property is optional, while a supplied
value is always checked against the declared media types. Canonical raw request files have an
empty name; multipart filenames and a file subtype's modeled path, query, or header filename are
mirrored into `File.name`. The modeled filename remains available as an ordinary handler input.
When a raw file is combined with other inputs, it is kept under the request model's body property
rather than flattened into them.

A `File` transported as a structured JSON body is instead represented by its projected object
shape: `contentType`, `filename`, and `contents`. String contents stay strings, while `bytes`
contents use `Uint8Array` in handlers and base64 on the JSON wire.

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
types. This check takes precedence over schema validation because the body cannot be decoded
safely. Request-size policy is evaluated earlier when a valid `Content-Length` already proves that
the body is oversized, so that case returns 413 without attempting media-type decoding.

Response status ranges and unions remain visible to handlers and are validated before they drive
the Fetch `Response`. Header-only responses are emitted without a body, and 204, 205, and 304
always suppress body bytes. A wildcard response without an `@statusCode` property is rejected at
generation time because no concrete status can be selected safely.

The hosting adapters preserve stream-backed Web `Request` and `Response` bodies at their boundary.
Generated request body decoders nevertheless consume the complete body before invoking a handler,
including JSON, URL-encoded form, multipart, text, binary, and raw file bodies. The runtime limits
these bodies to 10 MiB by default, rejecting larger declared or streamed payloads with a structured
413 response. Set `maxRequestBodyBytes` on `createHttpRouter` or direct body-decoder options to a
non-negative byte count; set it to `false` to disable runtime enforcement explicitly. Deployments
should still configure transport-level limits and request deadlines in their trusted proxy or
hosting runtime.

Modeled success and error values are encoded using their declared status, headers, body, and media
type. Full-range `int64` and `uint64` handler values use `bigint` and, without an explicit
encoding, are emitted as exact, unquoted JSON numeric tokens; clients interpret those tokens
according to their JSON number implementation. Inbound JSON integer tokens longer than 20 digits
are rejected before handler decoding to bound precise-integer parsing. TypeSpec `bytes` map to
`Uint8Array` and default to base64 strings when nested in JSON.

Standard TypeSpec `@encode` contracts are applied at every scalar boundary: JSON and text bodies,
path, query, header, and cookie parameters, multipart scalar parts, and modeled response headers.
Numeric and boolean values can be string-encoded; date-times support `rfc3339`, `rfc7231`, and
`unixTimestamp`; durations support `ISO8601`, `seconds`, and `milliseconds`; bytes support
`base64` and unpadded `base64url`. Encodings declared on a scalar are inherited and a property
encoding takes precedence. Unannotated HTTP values follow TypeSpec's protocol defaults:
date-times use RFC 7231 in headers and RFC 3339 elsewhere, durations use ISO 8601, and bytes use
base64 whenever the wire location is textual. Handler types stay semantic: date-times and
durations are strings, bytes are `Uint8Array`, and 64-bit integers are `bigint`. Date-time wire
values are converted to RFC 3339 handler strings, while numeric duration values become ISO 8601
handler strings. Raw binary bodies contain exact bytes and cannot apply a textual scalar encoding;
use a textual or JSON media type instead.

Lifecycle visibility is projected into each operation's handler-facing request and response
shape. HTTP method defaults and explicit `@parameterVisibility`/`@returnTypeVisibility` overrides
are honored, including configured PATCH optionality and collection-item rules. Canonical generated
model types remain complete while operation-local payload aliases describe the actual wire contract.

Standard `@discriminated` unions preserve their declared wire representation in handler types.
Object envelopes use the configured discriminator and value property names; `envelope: "none"`
injects the required discriminator into every model variant. Request decoding dispatches by that
field, response serialization transforms the selected payload recursively, and unnamed default
variants handle discriminator values that are not mapped explicitly.

Standard `@useAuth` requirements are exposed to middleware through the generated
`typeSpecAuthHint`. Each operation carries its fully resolved requirement after service,
namespace, interface, and operation overrides. The `options` array represents alternatives (OR),
while the `schemes` within an option must be satisfied together (AND); `NoAuth`, API keys, HTTP
schemes, OAuth 2.0 flows and scopes, and OpenID Connect metadata retain their declared details.
The runtime does not enforce a policy itself. Applications can import the generated key and apply
their own middleware:

```ts
import type { MatchedRequestContext, Middleware } from "@typespex/runtime/server";
import { typeSpecAuthHint } from "./generated/pet-store/server-hints.js";

export const authMiddleware: Middleware<MatchedRequestContext> = (next) => async (ctx) => {
  const auth = ctx.match?.endpoint.operation.hints.get(typeSpecAuthHint);
  // Interpret auth.options for the schemes supported by this application.
  if (auth && !requestSatisfies(auth, ctx.request)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return next(ctx);
};
```

A complete bearer-policy example is available in [`example/auth.ts`](./example/auth.ts).

Raw file responses accept a Web `File`, validate its media type, and use its name for a safe
`Content-Disposition` filename. Empty optional media types and names omit those response headers;
a filename relocated to a modeled response header suppresses the default `Content-Disposition`.

Handlers and middleware may throw `HttpError` for an explicit HTTP response. Other exceptions use
`onUnhandledError` when configured, otherwise the router returns status 500. Unmatched requests
through `router.handle()` return `{"error":"Not Found"}` with status 404 unless `notFound` is
configured.

## Current Contract Boundaries

The emitter reports an error instead of generating a wire contract it cannot preserve. Current
diagnostics cover custom or location-incompatible scalar encodings, non-JSON encoded property
names, and unsupported `@discriminated` configurations. They also reject ambiguous nested response
unions that require different JSON transforms, parameter serialization styles, media/body shape
combinations, and output layouts that the generated runtime cannot represent safely.
Authentication and authorization enforcement belongs in application middleware. Supported
response bodies are JSON, `text/*`,
`application/octet-stream`, resolved raw `File` media types, and empty responses. Multipart
response bodies remain unsupported.

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
