import { describe, expect, test } from "bun:test";
import { createRegexMatcher } from "../src/match-regex.js";
import { createRadixMatcher } from "../src/match-radix.js";

/**
 * Shared suite — both matchers must produce identical results.
 * Each test covers a distinct edge case. No repeating assertions.
 */
function matcherSuite(name: string, create: typeof createRegexMatcher) {
  describe(name, () => {
    const routes = [
      { method: "GET", path: "/health", route: "health" },
      { method: "GET", path: "/api/v1.0/status", route: "status" },
      { method: "GET", path: "/pets", route: "listPets" },
      { method: "POST", path: "/pets", route: "createPet" },
      { method: "GET", path: "/pets/:petId", route: "readPet" },
      { method: "DELETE", path: "/pets/:petId", route: "deletePet" },
      { method: "GET", path: "/users/:userId/posts/:postId", route: "readPost" },
      { method: "PUT", path: "/users/:userId/posts/:postId/tags/:tagId", route: "updateTag" },
    ];
    const matcher = create(routes);

    // --- Core matching ---

    test("static route, empty pathParams", () => {
      const m = matcher.match("GET", "/health");
      expect(m!.route).toBe("health");
      expect(m!.pathParams).toEqual({});
    });

    test("regex-special chars in static segment (dot)", () => {
      expect(matcher.match("GET", "/api/v1.0/status")!.route).toBe("status");
    });

    test("single param extraction", () => {
      const m = matcher.match("GET", "/pets/abc-123");
      expect(m!.route).toBe("readPet");
      expect(m!.pathParams).toEqual({ petId: "abc-123" });
    });

    test("two params", () => {
      const m = matcher.match("GET", "/users/u-1/posts/p-2");
      expect(m!.pathParams).toEqual({ userId: "u-1", postId: "p-2" });
    });

    test("three params deep nesting", () => {
      const m = matcher.match("PUT", "/users/u-1/posts/p-2/tags/t-3");
      expect(m!.pathParams).toEqual({ userId: "u-1", postId: "p-2", tagId: "t-3" });
    });

    // --- Method isolation ---

    test("same path, different methods → different routes", () => {
      expect(matcher.match("GET", "/pets")!.route).toBe("listPets");
      expect(matcher.match("POST", "/pets")!.route).toBe("createPet");
    });

    test("same param path, different methods", () => {
      expect(matcher.match("GET", "/pets/p-1")!.route).toBe("readPet");
      expect(matcher.match("DELETE", "/pets/p-1")!.route).toBe("deletePet");
    });

    // --- No match ---

    test("null for unregistered method", () => {
      expect(matcher.match("PATCH", "/pets")).toBeNull();
    });

    test("null for non-existent deep path", () => {
      expect(matcher.match("GET", "/does/not/exist/at/all")).toBeNull();
    });

    test("null for path longer than route", () => {
      expect(matcher.match("GET", "/health/extra")).toBeNull();
    });

    test("null for path shorter than route", () => {
      expect(matcher.match("GET", "/api")).toBeNull();
      expect(matcher.match("GET", "/api/v1.0")).toBeNull();
    });

    test("null for empty router", () => {
      expect(create([]).match("GET", "/anything")).toBeNull();
    });

    // --- Static vs param priority ---

    test("static wins over param at same depth", () => {
      expect(matcher.match("GET", "/pets")!.route).toBe("listPets");
    });

    test("static segment wins regardless of registration order", () => {
      const m = create([
        { method: "GET", path: "/pets/:petId", route: "readPet" },
        { method: "GET", path: "/pets/new", route: "newPet" },
      ]);

      expect(m.match("GET", "/pets/new")!.route).toBe("newPet");
      expect(m.match("GET", "/pets/other")!.route).toBe("readPet");
    });

    test("static priority is applied at the first differing segment", () => {
      const m = create([
        { method: "GET", path: "/:resource/new", route: "resourceAction" },
        { method: "GET", path: "/pets/:petId", route: "readPet" },
      ]);

      expect(m.match("GET", "/pets/new")!.route).toBe("readPet");
    });

    test("falls back to a param branch when a static branch dead-ends", () => {
      const m = create([
        { method: "GET", path: "/foo/qux/end", route: "staticBranch" },
        { method: "GET", path: "/foo/:value/end", route: "nestedParamBranch" },
        { method: "GET", path: "/:id/bar", route: "fallback" },
      ]);

      const match = m.match("GET", "/foo/bar");
      expect(match!.route).toBe("fallback");
      expect(match!.pathParams).toEqual({ id: "foo" });
    });

    test("uses parameter names from the matched route", () => {
      const m = create([
        { method: "GET", path: "/:id/a", route: "a" },
        { method: "GET", path: "/:name/b", route: "b" },
      ]);

      expect(m.match("GET", "/first/a")!.pathParams).toEqual({ id: "first" });
      expect(m.match("GET", "/second/b")!.pathParams).toEqual({ name: "second" });
    });

    // --- Param values with special characters ---

    test("param with dots, hyphens", () => {
      expect(matcher.match("GET", "/pets/v1.2-beta")!.pathParams).toEqual({ petId: "v1.2-beta" });
    });

    test("param with percent-encoding (opaque, not decoded)", () => {
      expect(matcher.match("GET", "/pets/hello%20world")!.pathParams).toEqual({
        petId: "hello%20world",
      });
    });

    test("encoded slash %2F stays inside param (not a separator)", () => {
      expect(matcher.match("GET", "/pets/a%2Fb")!.pathParams).toEqual({ petId: "a%2Fb" });
    });

    test("unicode in path segment", () => {
      expect(matcher.match("GET", "/pets/café")!.pathParams).toEqual({ petId: "café" });
    });

    test("emoji in path segment", () => {
      expect(matcher.match("GET", "/pets/🐱")!.pathParams).toEqual({ petId: "🐱" });
    });

    // --- Root path ---

    test("root path /", () => {
      const root = create([{ method: "GET", path: "/", route: "root" }]);
      const m = root.match("GET", "/");
      expect(m!.route).toBe("root");
      expect(m!.pathParams).toEqual({});
    });

    // --- Root-level catch-all param ---

    test("root-level param catches single segments, not multi", () => {
      const m = create([
        { method: "GET", path: "/health", route: "health" },
        { method: "GET", path: "/:id", route: "catchAll" },
      ]);
      expect(m.match("GET", "/health")!.route).toBe("health");
      expect(m.match("GET", "/other")!.route).toBe("catchAll");
      expect(m.match("GET", "/other")!.pathParams).toEqual({ id: "other" });
      expect(m.match("GET", "/a/b")).toBeNull();
    });

    // --- Duplicate / empty segments ---

    test("double slash produces empty segment (no match for most routes)", () => {
      // /pets//p-1 has segments ["pets", "", "p-1"] — doesn't match /pets/:petId (2 segments)
      expect(matcher.match("GET", "/pets//p-1")).toBeNull();
    });

    test("empty segment does not match a path parameter", () => {
      const m = create([{ method: "GET", path: "/pets/:petId/details", route: "details" }]);

      expect(m.match("GET", "/pets//details")).toBeNull();
    });

    test("pathname must start with a slash", () => {
      expect(matcher.match("GET", "pets")).toBeNull();
      expect(create([{ method: "GET", path: "/", route: "root" }]).match("GET", "")).toBeNull();
    });

    // --- Duplicate routes ---

    test("rejects exact duplicate routes", () => {
      expect(() =>
        create([
          { method: "GET", path: "/pets", route: "first" },
          { method: "GET", path: "/pets", route: "second" },
        ]),
      ).toThrow("Duplicate route: GET /pets");
    });

    test("rejects structurally duplicate routes with renamed params", () => {
      expect(() =>
        create([
          { method: "GET", path: "/pets/:petId", route: "first" },
          { method: "GET", path: "/pets/:id", route: "second" },
        ]),
      ).toThrow("Duplicate route: GET /pets/:id");
    });

    test("allows the same route structure for different methods", () => {
      expect(() =>
        create([
          { method: "GET", path: "/pets/:petId", route: "read" },
          { method: "DELETE", path: "/pets/:id", route: "remove" },
        ]),
      ).not.toThrow();
    });

    test("rejects malformed route patterns at registration", () => {
      for (const path of ["pets", "/pets/", "/pets//:id", "/pets/:", "/pets?view=all"]) {
        expect(() => create([{ method: "GET", path, route: "invalid" }])).toThrow(
          "Invalid route path",
        );
      }
    });

    test("rejects duplicate parameter names in one route", () => {
      expect(() =>
        create([{ method: "GET", path: "/teams/:id/members/:id", route: "invalid" }])
      ).toThrow('Duplicate path parameter "id"');
    });

    // --- Prototype-safe params ---

    test("param named constructor does not shadow Object.prototype", () => {
      const m = create([{ method: "GET", path: "/:constructor", route: "test" }]);
      const result = m.match("GET", "/value");
      expect(result!.pathParams.constructor).toBe("value");
    });

    test("param named __proto__ is a regular string value", () => {
      const m = create([{ method: "GET", path: "/:__proto__", route: "test" }]);
      const result = m.match("GET", "/value");
      expect(result!.pathParams.__proto__).toBe("value");
    });

    // --- Many routes (sanity check at scale) ---

    test("correct dispatch with 50 routes sharing prefixes", () => {
      const manyRoutes = Array.from({ length: 50 }, (_, i) => ({
        method: "GET",
        path: `/api/v1/resource${i}/:id`,
        route: `r${i}`,
      }));
      const big = create(manyRoutes);

      expect(big.match("GET", "/api/v1/resource0/abc")!.route).toBe("r0");
      expect(big.match("GET", "/api/v1/resource49/xyz")!.route).toBe("r49");
      expect(big.match("GET", "/api/v1/resource25/id")!.pathParams).toEqual({ id: "id" });
      expect(big.match("GET", "/api/v1/resource50/id")).toBeNull();
    });
  });
}

matcherSuite("createRegexMatcher", createRegexMatcher);
matcherSuite("createRadixMatcher", createRadixMatcher);

// --- Trailing slash ---

describe("trailing slash", () => {
  const routes = [{ method: "GET", path: "/pets", route: "listPets" }];

  test("regex: rejects trailing slash", () => {
    expect(createRegexMatcher(routes).match("GET", "/pets/")).toBeNull();
  });

  test("radix: rejects trailing slash", () => {
    expect(createRadixMatcher(routes).match("GET", "/pets/")).toBeNull();
  });
});
