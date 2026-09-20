import { describe, expect, test } from "bun:test";
import {
  bindRoute,
  createHttpRouter,
  Either,
  emptyHints,
  getHttpTransportRoutes,
  HttpError,
  RequestBodyTooLargeError,
  type HttpRouterOptions,
  type MatchedRequestContext,
  type ServerOperation,
} from "../src/index.js";

function operation(): ServerOperation<void, string> {
  return {
    endpoint: {
      service: { name: "Direct", hints: emptyHints() },
      namespaces: [],
      operation: {
        name: "read",
        operationId: "Direct.read",
        method: "GET",
        path: "/value",
        hints: emptyHints(),
      },
    },
    decodeInput: () => Either.right(undefined),
    encodeResult: (value) => new Response(value),
  };
}

function registration(handler: () => string | Promise<string>, op = operation()) {
  const router = createHttpRouter([bindRoute(op, handler)]);
  return getHttpTransportRoutes(router)![0]!;
}

const request = () => new Request("http://localhost/value");

function trackedPromise(state: "fulfilled" | "pending" | "rejected", reads: string[]) {
  const value =
    state === "fulfilled"
      ? Promise.resolve("ok")
      : state === "pending"
        ? new Promise<string>((resolve) => queueMicrotask(() => resolve("ok")))
        : Promise.reject<string>(new HttpError(409, "conflict"));
  Object.defineProperty(value, "constructor", {
    get() {
      reads.push("constructor");
      return Promise;
    },
  });
  return value;
}

describe("direct transport dispatch", () => {
  test("returns synchronous responses while the existing entry point stays Promise-based", async () => {
    for (const handler of [() => "ok", () => Promise.resolve("ok")]) {
      const route = registration(handler);
      const direct = route.dispatch!(request(), {}, Bun.peek);
      expect(direct).toBeInstanceOf(Response);
      expect(await (direct as Response).text()).toBe("ok");
      const ordinary = route.handle(request(), {});
      expect(ordinary).toBeInstanceOf(Promise);
      expect(await (await ordinary).text()).toBe("ok");
    }
  });

  test("reads Promise constructors once for every settlement state", async () => {
    for (const state of ["fulfilled", "pending", "rejected"] as const) {
      const reads: string[] = [];
      const route = registration(() => trackedPromise(state, reads));
      const response = await route.dispatch!(request(), {}, Bun.peek);
      expect(reads).toEqual(["constructor"]);
      expect(response.status).toBe(state === "rejected" ? 409 : 200);
      await response.text();
    }
  });

  test("ignores an overridden then on a native Promise with the ordinary constructor", async () => {
    const route = registration(() => {
      const value = Promise.resolve("ok");
      Object.defineProperty(value, "then", {
        get() {
          throw new Error("unexpected then");
        },
      });
      return value;
    });
    expect(await (await route.dispatch!(request(), {}, Bun.peek)).text()).toBe("ok");
  });

  test("assimilates thenables once, including their receiver and multiple settlement attempts", async () => {
    const reads: string[] = [];
    const value = {
      get then() {
        reads.push("get then");
        return function (
          this: unknown,
          resolve: (value: string) => void,
          reject: (error: Error) => void,
        ) {
          expect(this).toBe(value);
          reads.push("call then");
          resolve("ok");
          reject(new Error("ignored"));
          resolve("ignored");
          throw new Error("ignored");
        };
      },
    };
    const route = registration(() => value as unknown as Promise<string>);
    expect(await (await route.dispatch!(request(), {}, Bun.peek)).text()).toBe("ok");
    expect(reads).toEqual(["get then", "call then"]);
  });

  test("does not inspect the prototype of a plain proxy result", async () => {
    const value = new Proxy(
      { text: "ok" },
      {
        getPrototypeOf() {
          throw new Error("unexpected prototype lookup");
        },
      },
    );
    const op = operation();
    op.encodeResult = (result) => new Response((result as unknown as typeof value).text);
    const route = registration(() => value as unknown as string, op);
    expect(await (await route.dispatch!(request(), {}, Bun.peek)).text()).toBe("ok");
  });

  test("preserves asynchronous decoding and decoder errors without invoking the handler", async () => {
    let calls = 0;
    const op = operation();
    op.decodeInput = async () => Either.right(undefined);
    const route = registration(() => {
      calls++;
      return "ok";
    }, op);
    expect(await (await route.dispatch!(request(), {}, Bun.peek)).text()).toBe("ok");
    expect(calls).toBe(1);
    for (const asynchronous of [false, true]) {
      op.decodeInput = () => {
        const result = Either.left(new RequestBodyTooLargeError(3));
        return asynchronous ? Promise.resolve(result) : result;
      };
      const response = await route.dispatch!(request(), {}, Bun.peek);
      expect(response.status).toBe(413);
      await response.text();
      expect(calls).toBe(1);
    }
  });

  test("returns rejected Promises for synchronous execution and error-conversion failures", async () => {
    const failure = new Error("failed");
    const throwing = () => {
      throw failure;
    };
    class BrokenHttpError extends HttpError {
      override toResponse(): Response {
        throw failure;
      }
    }
    const cases = [
      registration(throwing),
      registration(() => "ok", { ...operation(), decodeInput: throwing }),
      registration(() => "ok", { ...operation(), encodeResult: throwing }),
      registration(() => {
        throw new BrokenHttpError(409, "conflict");
      }),
      registration(() => {
        const value = Promise.resolve("ok");
        Object.defineProperty(value, "constructor", { get: throwing });
        return value;
      }),
    ];
    for (const route of cases) {
      let response: Response | Promise<Response> | undefined;
      expect(() => {
        response = route.dispatch!(request(), {}, Bun.peek);
      }).not.toThrow();
      expect(response).toBeInstanceOf(Promise);
      await expect(response as Promise<Response>).rejects.toBe(failure);
      const ordinary = route.handle(request(), {});
      expect(ordinary).toBeInstanceOf(Promise);
      await expect(ordinary).rejects.toBe(failure);
    }
  });

  test("converts asynchronous decode, handler, and encode failures exactly once", async () => {
    for (const stage of ["decode", "handler", "encode"] as const) {
      for (const asynchronousDecode of [false, true]) {
        let conversions = 0;
        class TrackedError extends HttpError {
          override toResponse(): Response {
            conversions++;
            return super.toResponse();
          }
        }
        const error = new TrackedError(409, "conflict");
        const op = operation();
        op.decodeInput = () => {
          if (stage === "decode") return Promise.reject(error);
          const result = Either.right(undefined);
          return asynchronousDecode ? Promise.resolve(result) : result;
        };
        if (stage === "encode")
          op.encodeResult = () => {
            throw error;
          };
        const route = registration(async () => {
          await Promise.resolve();
          if (stage === "handler") throw error;
          return "ok";
        }, op);
        const response = await route.dispatch!(request(), {}, Bun.peek);
        expect(response.status).toBe(409);
        expect(conversions).toBe(1);
        await response.text();
      }
    }
  });

  test("rejects invalid transport facts before a handler can run", async () => {
    const route = registration(() => {
      throw new Error("handler must not run");
    });
    const original = request();
    const response = route.dispatch!(original, {}, Bun.peek, {
      request: original,
      verifiedBodyLength: -1,
    });
    expect(response).toBeInstanceOf(Promise);
    await expect(response as Promise<Response>).rejects.toBeInstanceOf(RangeError);
  });

  test("hook presence selects ordinary dispatch without evaluating an error hook getter", async () => {
    let reads = 0;
    for (const options of [
      {
        get onUnhandledError() {
          reads++;
          return undefined;
        },
      },
      { onUnhandledError: undefined },
    ]) {
      const router = createHttpRouter([bindRoute(operation(), () => "ok")], options);
      const route = getHttpTransportRoutes(router)![0]!;
      const response = route.dispatch!(request(), {}, Bun.peek);
      expect(response).toBeInstanceOf(Promise);
      expect(await (await response).text()).toBe("ok");
    }
    expect(reads).toBe(0);
  });

  test("hook getters keep ordinary access behavior and middleware receives a Promise", async () => {
    let errorHookReads = 0;
    const options: HttpRouterOptions<MatchedRequestContext> = {
      get onUnhandledError() {
        errorHookReads++;
        return undefined;
      },
      middleware: [
        (next) => (context) => {
          const result = next(context);
          expect(result).toBeInstanceOf(Promise);
          return result;
        },
      ],
    };
    const router = createHttpRouter([bindRoute(operation(), () => "ok")], options);
    const route = getHttpTransportRoutes(router)![0]!;
    expect(await (await route.dispatch!(request(), {}, Bun.peek)).text()).toBe("ok");
    expect(errorHookReads).toBe(0);
  });

  test("honors an error hook added while a handler is pending", async () => {
    const options: {
      onUnhandledError?: HttpRouterOptions<MatchedRequestContext>["onUnhandledError"];
    } = {};
    const router = createHttpRouter(
      [
        bindRoute(operation(), async () => {
          await Promise.resolve();
          options.onUnhandledError = (_error, context) =>
            new Response(context.request.url, { status: 503 });
          throw new Error("failed");
        }),
      ],
      options,
    );
    const route = getHttpTransportRoutes(router)![0]!;
    const response = await route.dispatch!(request(), {}, Bun.peek);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("http://localhost/value");
  });

  test("honors a replaced router handler and rejects its synchronous failures", async () => {
    const router = createHttpRouter([bindRoute(operation(), () => "original")]);
    const route = getHttpTransportRoutes(router)![0]!;
    router.handle = async () => new Response("replacement");
    expect(await (await route.dispatch!(request(), {}, Bun.peek)).text()).toBe("replacement");
    const failure = new Error("wrapper failed");
    router.handle = () => {
      throw failure;
    };
    const response = route.dispatch!(request(), {}, Bun.peek);
    expect(response).toBeInstanceOf(Promise);
    await expect(response as Promise<Response>).rejects.toBe(failure);
  });
});
