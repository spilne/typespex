import { describe, expect, test } from "bun:test";
import {
  Decoders,
  Either,
  createContextKey,
  createContextMap,
  createHttpRouter,
  decode,
  emptyHints,
  type MatchedRequestContext,
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
            if (ctx.match?.endpoint.operation.operationId === operation.endpoint.operation.operationId) {
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
        return Response.json({
          error: "Not Found",
          userId: ctx.state.get(UserIdKey),
          matched: ctx.match !== undefined,
        }, { status: 404 });
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
        const value = new URL(request.url).searchParams.get("limit");
        return Either.map(
          decode(Decoders.number, value, "$query.limit"),
          (limit) => ({ limit }),
        );
      },
      encodeResult(result: { limit: number }) {
        return Response.json(result, { status: 200 });
      },
    });

    const router = createHttpRouter(
      [
        {
          operation,
          async handler(input) {
            return input;
          },
        },
      ],
    );

    const response = await router.handle(new Request("http://localhost/pets?limit=wat"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid request",
      issues: [{ path: "$query.limit", message: "Expected a finite number." }],
    });
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
        async createContext(request, match) {
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
});
