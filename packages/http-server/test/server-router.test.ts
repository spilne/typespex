import { describe, expect, test } from "bun:test";
import {
  Decoders,
  Either,
  bindRoute,
  createContextKey,
  createContextMap,
  createHttpRouter,
  decodeRequestInput,
  emptyHints,
  type MatchedRequestContext,
  RequestDecoders,
  type RequestContext,
  type ServerOperation,
} from "../src/server.js";

const UserIdKey = createContextKey<string>("user.id");

function makeOperation<I, R>(operation: ServerOperation<I, R>): ServerOperation<I, R> {
  return operation;
}

describe("createHttpRouter", () => {
  test("encodes successful outcomes", async () => {
    const operation = makeOperation({
      endpoint: {
        service: {
          name: "TestService",
          hints: emptyHints(),
        },
        namespaces: [],
        operation: {
          name: "readPet",
          operationId: "Pets.read",
          method: "GET",
          path: "/pets/:petId",
          hints: emptyHints(),
        },
      },
      decodeInput(_request, pathParams) {
        return Either.right({ petId: pathParams.petId });
      },
      encodeResult(result) {
        return Response.json(result, { status: 200 });
      },
    });

    const router = createHttpRouter([
      {
        operation,
        async handler(input, ctx: MatchedRequestContext) {
          return {
            id: input.petId,
            seenBy: ctx.match.endpoint.operation.operationId,
          };
        },
      },
    ]);

    const response = await router.handle(new Request("http://localhost/pets/p-123"));

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({
      id: "p-123",
      seenBy: "Pets.read",
    });
  });

  test("routes embedded parameters raw and decodes them exactly once at the input boundary", async () => {
    const operation = makeOperation({
      endpoint: {
        service: {
          name: "TestService",
          hints: emptyHints(),
        },
        namespaces: [],
        operation: {
          name: "readFile",
          operationId: "Files.read",
          method: "GET",
          path: "/files/{id}.json",
          routePattern: {
            segments: [
              [{ kind: "literal", value: "files" }],
              [
                { kind: "parameter", name: "id" },
                { kind: "literal", value: ".json" },
              ],
            ],
            trailingSlash: false,
          },
          hints: emptyHints(),
        },
      },
      decodeInput(request, pathParams) {
        return decodeRequestInput(
          RequestDecoders.path("id", Decoders.string).map((id) => ({ id })),
          request,
          pathParams,
        );
      },
      encodeResult(result: { id: string }) {
        return Response.json(result, { status: 200 });
      },
    });
    const router = createHttpRouter([bindRoute(operation, async (input) => input)]);

    const encoded = await router.handle(new Request("http://localhost/files/a%2Fb%20c.json"));
    expect(encoded.status).toBe(200);
    expect(await encoded.json()).toEqual({ id: "a/b c" });

    const malformed = await router.handle(new Request("http://localhost/files/bad%ZZ.json"));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: "Invalid request",
      issues: [
        {
          path: "$path.id",
          message: "Expected a valid percent-encoded path segment.",
        },
      ],
    });
  });

  test("registers every concrete route pattern for one operation", async () => {
    const operation = makeOperation<{ name?: string }, { name: string | null }>({
      endpoint: {
        service: { name: "TestService", hints: emptyHints() },
        namespaces: [],
        operation: {
          name: "optional",
          operationId: "Parameters.optional",
          method: "GET",
          path: "/optional{/name}",
          routePatterns: [
            {
              segments: [[{ kind: "literal", value: "optional" }]],
              trailingSlash: false,
            },
            {
              segments: [
                [{ kind: "literal", value: "optional" }],
                [{ kind: "parameter", name: "name" }],
              ],
              trailingSlash: false,
            },
          ],
          hints: emptyHints(),
        },
      },
      decodeInput(request, pathParams) {
        return decodeRequestInput(
          RequestDecoders.path("name", Decoders.string.optional()).map((name) => ({ name })),
          request,
          pathParams,
        );
      },
      encodeResult(result) {
        return Response.json(result, { status: 200 });
      },
    });
    const router = createHttpRouter([
      bindRoute(operation, async ({ name }) => ({ name: name ?? null })),
    ]);

    const absent = await router.handle(new Request("http://localhost/optional"));
    expect(absent.status).toBe(200);
    expect(await absent.json()).toEqual({ name: null });

    const present = await router.handle(new Request("http://localhost/optional/value"));
    expect(present.status).toBe(200);
    expect(await present.json()).toEqual({ name: "value" });

    expect((await router.handle(new Request("http://localhost/optional/"))).status).toBe(404);
  });

  test("rejects an empty concrete route pattern list", () => {
    const operation = makeOperation<{}, void>({
      endpoint: {
        service: { name: "TestService", hints: emptyHints() },
        namespaces: [],
        operation: {
          name: "invalid",
          operationId: "Parameters.invalid",
          method: "GET",
          path: "/invalid",
          routePatterns: [],
          hints: emptyHints(),
        },
      },
      decodeInput() {
        return Either.right({});
      },
      encodeResult() {
        return new Response(null, { status: 204 });
      },
    });

    expect(() => createHttpRouter([bindRoute(operation, async () => undefined)])).toThrow(
      'Operation "Parameters.invalid" has no route patterns.',
    );
  });

  test("matches fixed query constraints before decoding or fallthrough", async () => {
    const operation = makeOperation<{}, { matched: true }>({
      endpoint: {
        service: { name: "TestService", hints: emptyHints() },
        namespaces: [],
        operation: {
          name: "constrained",
          operationId: "Query.constrained",
          method: "GET",
          path: "/query",
          routeSelection: { query: [{ name: "fixed", value: "true" }] },
          hints: emptyHints(),
        },
      },
      decodeInput() {
        return Either.right({});
      },
      encodeResult(result) {
        return Response.json(result, { status: 200 });
      },
    });
    const router = createHttpRouter([
      bindRoute(operation, async () => ({ matched: true as const })),
    ]);

    const matched = await router.handle(
      new Request("http://localhost/query?other=value&f%69xed=tr%75e"),
    );
    expect(matched.status).toBe(200);
    expect(await matched.json()).toEqual({ matched: true });
    expect((await router.handle(new Request("http://localhost/query"))).status).toBe(404);
    expect((await router.handle(new Request("http://localhost/query?fixed=false"))).status).toBe(
      404,
    );
    expect(
      (await router.handle(new Request("http://localhost/query?fixed=true&f%69xed=true"))).status,
    ).toBe(404);
    expect(
      await router.tryHandle(new Request("http://localhost/query?fixed=false")),
    ).toBeUndefined();
  });

  test("canonicalizes path spelling before route selection while decoding captures once", async () => {
    const parameter = makeOperation({
      endpoint: {
        service: { name: "TestService", hints: emptyHints() },
        namespaces: [],
        operation: {
          name: "readPet",
          operationId: "Pets.read",
          method: "GET",
          path: "/pets/:petId",
          hints: emptyHints(),
        },
      },
      decodeInput(request, pathParams) {
        return decodeRequestInput(
          RequestDecoders.path("petId", Decoders.string).map((petId) => ({
            route: "parameter" as const,
            value: petId,
          })),
          request,
          pathParams,
        );
      },
      encodeResult(result: { route: "parameter"; value: string }) {
        return Response.json(result, { status: 200 });
      },
    });
    const staticPet = makeOperation({
      endpoint: {
        service: { name: "TestService", hints: emptyHints() },
        namespaces: [],
        operation: {
          name: "newPet",
          operationId: "Pets.new",
          method: "GET",
          path: "/pets/new",
          hints: emptyHints(),
        },
      },
      decodeInput() {
        return Either.right({ route: "static" as const });
      },
      encodeResult(result: { route: "static" }) {
        return Response.json(result, { status: 200 });
      },
    });
    const unicode = makeOperation({
      endpoint: {
        service: { name: "TestService", hints: emptyHints() },
        namespaces: [],
        operation: {
          name: "cafe",
          operationId: "Cafe.read",
          method: "GET",
          path: "/café",
          hints: emptyHints(),
        },
      },
      decodeInput() {
        return Either.right({ route: "unicode" as const });
      },
      encodeResult(result: { route: "unicode" }) {
        return Response.json(result, { status: 200 });
      },
    });
    const router = createHttpRouter([
      bindRoute(parameter, async (input) => input),
      bindRoute(staticPet, async (input) => input),
      bindRoute(unicode, async (input) => input),
    ]);

    const selectedStatic = await router.handle(new Request("http://localhost/pets/%6Eew"));
    expect(await selectedStatic.json()).toEqual({ route: "static" });

    const selectedUnicode = await router.handle(new Request("http://localhost/caf%C3%A9"));
    expect(await selectedUnicode.json()).toEqual({ route: "unicode" });

    const encodedSlash = await router.handle(new Request("http://localhost/pets/%2F"));
    expect(await encodedSlash.json()).toEqual({ route: "parameter", value: "/" });

    const doubleEncodedSlash = await router.handle(new Request("http://localhost/pets/%252F"));
    expect(await doubleEncodedSlash.json()).toEqual({ route: "parameter", value: "%2F" });

    const malformed = await router.handle(new Request("http://localhost/pets/%ZZ"));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: "Invalid request",
      issues: [
        {
          path: "$path.petId",
          message: "Expected a valid percent-encoded path segment.",
        },
      ],
    });

    const wrongTrailingSlash = await router.handle(new Request("http://localhost/caf%C3%A9/"));
    expect(wrongTrailingSlash.status).toBe(404);
  });

  test("encodes declared failures as modeled results", async () => {
    const operation = makeOperation({
      endpoint: {
        service: {
          name: "TestService",
          hints: emptyHints(),
        },
        namespaces: [],
        operation: {
          name: "readPet",
          operationId: "Pets.read",
          method: "GET",
          path: "/pets/:petId",
          hints: emptyHints(),
        },
      },
      decodeInput(_request, pathParams) {
        return Either.right({ petId: pathParams.petId });
      },
      encodeResult(result: { id: string } | { code: "NOT_FOUND"; message: string }) {
        if ("code" in result) return Response.json(result, { status: 404 });
        return Response.json(result, { status: 200 });
      },
    });

    const router = createHttpRouter([
      {
        operation,
        async handler(input) {
          return {
            code: "NOT_FOUND" as const,
            message: `Missing ${input.petId}`,
          };
        },
      },
    ]);

    const response = await router.handle(new Request("http://localhost/pets/missing"));

    expect(response).not.toBeNull();
    expect(response!.status).toBe(404);
    expect(await response!.json()).toEqual({
      code: "NOT_FOUND",
      message: "Missing missing",
    });
  });

  test("runs middleware around semantic execution", async () => {
    const operation = makeOperation({
      endpoint: {
        service: {
          name: "TestService",
          hints: emptyHints(),
        },
        namespaces: [],
        operation: {
          name: "listPets",
          operationId: "Pets.list",
          method: "GET",
          path: "/pets",
          hints: emptyHints(),
        },
      },
      decodeInput() {
        return Either.right({ limit: 1 });
      },
      encodeResult(result: { userId: string; limit: number }) {
        return Response.json(result, { status: 200 });
      },
    });

    const router = createHttpRouter(
      [
        {
          operation,
          async handler(input, ctx) {
            const userId = ctx.state.get(UserIdKey);
            return {
              userId: userId ?? "unknown",
              limit: input.limit,
            };
          },
        },
      ],
      {
        middleware: [
          (app) => async (ctx) => {
            if (
              ctx.match?.endpoint.operation.operationId === operation.endpoint.operation.operationId
            ) {
              expect(ctx.match?.endpoint.operation.name).toBe("listPets");
              ctx.state.set(UserIdKey, "u-42");
            }
            return app(ctx);
          },
        ],
      },
    );

    const response = await router.handle(new Request("http://localhost/pets"));

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({
      userId: "u-42",
      limit: 1,
    });
  });

  test("runs middleware for unmatched requests", async () => {
    const router = createHttpRouter([], {
      middleware: [
        (app) => async (ctx: RequestContext) => {
          ctx.state.set(UserIdKey, "miss");
          return app(ctx);
        },
      ],
      notFound: async (ctx) => {
        return Response.json(
          {
            error: "Not Found",
            userId: ctx.state.get(UserIdKey),
            matched: ctx.match !== undefined,
          },
          { status: 404 },
        );
      },
    });

    const response = await router.handle(new Request("http://localhost/unknown"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Not Found",
      userId: "miss",
      matched: false,
    });
  });

  test("returns validation errors for invalid decoded input", async () => {
    const operation = makeOperation({
      endpoint: {
        service: {
          name: "TestService",
          hints: emptyHints(),
        },
        namespaces: [],
        operation: {
          name: "listPets",
          operationId: "Pets.list",
          method: "GET",
          path: "/pets",
          hints: emptyHints(),
        },
      },
      decodeInput(request) {
        return decodeRequestInput(
          RequestDecoders.query("limit", Decoders.number).map((limit) => ({ limit })),
          request,
          {},
        );
      },
      encodeResult(result: { limit: number }) {
        return Response.json(result, { status: 200 });
      },
    });

    const router = createHttpRouter([
      {
        operation,
        async handler(input) {
          return input;
        },
      },
    ]);

    const response = await router.handle(new Request("http://localhost/pets?limit=wat"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid request",
      issues: [{ path: "$query.limit", message: "Expected a finite number." }],
    });

    const malformed = await router.handle(new Request("http://localhost/pets?limit=%ZZ"));

    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: "Invalid request",
      issues: [
        {
          path: "$query.limit",
          message: "Expected a valid percent-encoded query value.",
        },
      ],
    });
  });

  test("accepts a request when a generated-style optional header is absent", async () => {
    const operation = makeOperation({
      endpoint: {
        service: { name: "TestService", hints: emptyHints() },
        namespaces: [],
        operation: {
          name: "readPet",
          operationId: "Pets.read",
          method: "GET",
          path: "/pets",
          hints: emptyHints(),
        },
      },
      decodeInput(request, pathParams) {
        return decodeRequestInput(
          RequestDecoders.header("x-trace-id", Decoders.string.optional()).map((traceId) => ({
            traceId,
          })),
          request,
          pathParams,
        );
      },
      encodeResult(result: { traceId?: string }) {
        return Response.json({ traceId: result.traceId ?? null }, { status: 200 });
      },
    });

    const router = createHttpRouter([
      {
        operation,
        async handler(input) {
          return input;
        },
      },
    ]);

    const response = await router.handle(new Request("http://localhost/pets"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ traceId: null });
  });

  test("custom createContext factory injects into handler", async () => {
    const operation = makeOperation({
      endpoint: {
        service: { name: "TestService", hints: emptyHints() },
        namespaces: [],
        operation: {
          name: "listPets",
          operationId: "Pets.list",
          method: "GET",
          path: "/pets",
          hints: emptyHints(),
        },
      },
      decodeInput() {
        return Either.right({});
      },
      encodeResult(result: { userId: string }) {
        return Response.json(result, { status: 200 });
      },
    });

    const router = createHttpRouter(
      [
        {
          operation,
          async handler(_input, ctx) {
            return {
              userId: ctx.state.get(UserIdKey) ?? "none",
            };
          },
        },
      ],
      {
        createContext(request, match) {
          const state = createContextMap();
          state.set(UserIdKey, "custom-user");
          return { request, match, state } as RequestContext;
        },
      },
    );

    const response = await router.handle(new Request("http://localhost/pets"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: "custom-user" });
  });

  test("tryHandle returns undefined without running unmatched middleware or notFound", async () => {
    const calls: string[] = [];
    const router = createHttpRouter([], {
      middleware: [
        (app) => async (ctx) => {
          calls.push("middleware");
          return app(ctx);
        },
      ],
      createContext(request, match) {
        calls.push("context");
        return { request, match, state: createContextMap() };
      },
      notFound() {
        calls.push("notFound");
        return new Response("runtime not found", { status: 404 });
      },
    });

    const response = await router.tryHandle(new Request("http://localhost/unknown"));

    expect(response).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("tryHandle preserves a matched operation's 404 response", async () => {
    const operation = makeOperation({
      endpoint: {
        service: { name: "TestService", hints: emptyHints() },
        namespaces: [],
        operation: {
          name: "readPet",
          operationId: "Pets.read",
          method: "GET",
          path: "/pets/:petId",
          hints: emptyHints(),
        },
      },
      decodeInput(_request, pathParams) {
        return Either.right({ petId: pathParams.petId });
      },
      encodeResult(result: { code: "NOT_FOUND"; petId: string }) {
        return Response.json(result, { status: 404 });
      },
    });
    const router = createHttpRouter([
      bindRoute(operation, async ({ petId }) => ({
        code: "NOT_FOUND" as const,
        petId,
      })),
    ]);

    const response = await router.tryHandle(new Request("http://localhost/pets/missing"));

    expect(response?.status).toBe(404);
    expect(await response?.json()).toEqual({
      code: "NOT_FOUND",
      petId: "missing",
    });
  });

  test("onUnhandledError handler receives context and returns custom response", async () => {
    const operation = makeOperation({
      endpoint: {
        service: { name: "TestService", hints: emptyHints() },
        namespaces: [],
        operation: {
          name: "boom",
          operationId: "Test.boom",
          method: "GET",
          path: "/boom",
          hints: emptyHints(),
        },
      },
      decodeInput() {
        return Either.right({});
      },
      encodeResult() {
        return Response.json({}, { status: 200 });
      },
    });

    const router = createHttpRouter(
      [
        {
          operation,
          async handler() {
            throw new Error("something broke");
          },
        },
      ],
      {
        onUnhandledError(error, ctx) {
          return Response.json(
            {
              error: (error as Error).message,
              path: ctx.match?.endpoint.operation.path,
            },
            { status: 503 },
          );
        },
      },
    );

    const response = await router.handle(new Request("http://localhost/boom"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "something broke",
      path: "/boom",
    });
  });

  test("lets unexpected failures reach the host error boundary by default", async () => {
    const failure = new Error("something broke");
    const operation = makeOperation({
      endpoint: {
        service: { name: "TestService", hints: emptyHints() },
        namespaces: [],
        operation: {
          name: "boom",
          operationId: "Test.boom",
          method: "GET",
          path: "/boom",
          hints: emptyHints(),
        },
      },
      decodeInput() {
        return Either.right({});
      },
      encodeResult() {
        return Response.json({}, { status: 200 });
      },
    });
    const router = createHttpRouter([
      bindRoute(operation, async () => {
        throw failure;
      }),
    ]);

    await expect(router.handle(new Request("http://localhost/boom"))).rejects.toBe(failure);
  });
});
