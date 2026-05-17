import { describe, expect, test } from "bun:test";
import {
  absurd,
  createContextKey,
  createContextMap,
  createHintKey,
  createHints,
  createTypedKey,
  emptyHints,
} from "../src/server.js";
import { HttpError } from "../src/errors.js";
import { getSearchParams } from "../src/http/query-params.js";

describe("HttpError", () => {
  test("toResponse with JSON body", () => {
    const error = new HttpError(400, "Bad Request", { error: "validation failed" });
    const response = error.toResponse();
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  test("toResponse with plain message (no body)", () => {
    const error = new HttpError(503, "Service Unavailable");
    const response = error.toResponse();
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBeNull();
  });

  test("toResponse with custom headers", () => {
    const error = new HttpError(429, "Too Many Requests", null, {
      "retry-after": "60",
    });
    const response = error.toResponse();
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
  });
});

describe("absurd", () => {
  test("throws if ever reached at runtime", () => {
    expect(() => absurd("oops" as never)).toThrow("absurd");
  });
});

describe("TypedKey / ContextKey / HintKey", () => {
  test("createTypedKey produces unique symbols", () => {
    const a = createTypedKey<string>("test");
    const b = createTypedKey<string>("test");
    expect(a.name).toBe("test");
    expect(b.name).toBe("test");
    expect(a.symbol).not.toBe(b.symbol); // unique symbols
  });

  test("createContextKey is aliased to createTypedKey", () => {
    const key = createContextKey<number>("count");
    expect(key.name).toBe("count");
    expect(typeof key.symbol).toBe("symbol");
  });

  test("createHintKey is aliased to createTypedKey", () => {
    const key = createHintKey<boolean>("flag");
    expect(key.name).toBe("flag");
    expect(typeof key.symbol).toBe("symbol");
  });
});

describe("ContextMap (lazy)", () => {
  test("get returns undefined before any set", () => {
    const map = createContextMap();
    const key = createContextKey<string>("test");
    expect(map.get(key)).toBeUndefined();
  });

  test("set then get returns the value", () => {
    const map = createContextMap();
    const key = createContextKey<number>("count");
    map.set(key, 42);
    expect(map.get(key)).toBe(42);
  });

  test("different keys are independent", () => {
    const map = createContextMap();
    const a = createContextKey<string>("a");
    const b = createContextKey<string>("b");
    map.set(a, "hello");
    expect(map.get(a)).toBe("hello");
    expect(map.get(b)).toBeUndefined();
  });
});

describe("Hints", () => {
  test("emptyHints returns singleton", () => {
    expect(emptyHints()).toBe(emptyHints());
  });

  test("emptyHints has no entries", () => {
    const hints = emptyHints();
    const key = createHintKey<string>("test");
    expect(hints.get(key)).toBeUndefined();
    expect(hints.has(key)).toBe(false);
    expect([...hints.entries()]).toEqual([]);
  });

  test("createHints stores and retrieves typed values", () => {
    const docKey = createHintKey<string>("doc");
    const tagKey = createHintKey<string[]>("tags");
    const hints = createHints([
      [docKey, "A pet"],
      [tagKey, ["animal", "pet"]],
    ]);

    expect(hints.get(docKey)).toBe("A pet");
    expect(hints.get(tagKey)).toEqual(["animal", "pet"]);
    expect(hints.has(docKey)).toBe(true);
  });

  test("createHints entries() iterates all pairs", () => {
    const a = createHintKey<string>("a");
    const b = createHintKey<number>("b");
    const hints = createHints([[a, "hello"], [b, 42]]);
    const entries = [...hints.entries()];
    expect(entries).toHaveLength(2);
  });
});

describe("getSearchParams", () => {
  test("parses query string from URL", () => {
    const params = getSearchParams("http://localhost/pets?limit=10&offset=0");
    expect(params.get("limit")).toBe("10");
    expect(params.get("offset")).toBe("0");
  });

  test("returns empty params for URL without query", () => {
    const params = getSearchParams("http://localhost/pets");
    expect(params.get("limit")).toBeNull();
    expect([...params.keys()]).toEqual([]);
  });

  test("handles bare path with query", () => {
    const params = getSearchParams("/pets?tag=cat");
    expect(params.get("tag")).toBe("cat");
  });
});
