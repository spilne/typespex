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

    test("embedded suffix parameters preserve their exact names and raw values", () => {
      const embedded = create([
        {
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
          route: "file",
        },
      ]);

      expect(embedded.match("GET", "/files/example.json")!.pathParams).toEqual({
        id: "example",
      });
      expect(embedded.match("GET", "/files/a%2Fb%20c.json")!.pathParams).toEqual({
        id: "a%2Fb%20c",
      });
      expect(embedded.match("GET", "/files/.json")!.pathParams).toEqual({ id: "" });
      expect(embedded.match("GET", "/files/example.txt")).toBeNull();
    });

    test("supports literal prefixes and multiple embedded variables", () => {
      const embedded = create([
        {
          method: "GET",
          path: "/releases/v{version}",
          routePattern: {
            segments: [
              [{ kind: "literal", value: "releases" }],
              [
                { kind: "literal", value: "v" },
                { kind: "parameter", name: "version" },
              ],
            ],
            trailingSlash: false,
          },
          route: "release",
        },
        {
          method: "GET",
          path: "/coordinates/{x,y}",
          routePattern: {
            segments: [
              [{ kind: "literal", value: "coordinates" }],
              [
                { kind: "parameter", name: "x" },
                { kind: "literal", value: "," },
                { kind: "parameter", name: "y" },
              ],
            ],
            trailingSlash: false,
          },
          route: "coordinates",
        },
      ]);

      expect(embedded.match("GET", "/releases/v1.2")!.pathParams).toEqual({
        version: "1.2",
      });
      expect(embedded.match("GET", "/coordinates/a%2Fb,c%20d")!.pathParams).toEqual({
        x: "a%2Fb",
        y: "c%20d",
      });
      expect(embedded.match("GET", "/coordinates/,right")!.pathParams).toEqual({
        x: "",
        y: "right",
      });
      expect(embedded.match("GET", "/coordinates/left,")!.pathParams).toEqual({
        x: "left",
        y: "",
      });
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

    test("orders static, mixed, and whole-parameter segments by specificity", () => {
      const routesBySpecificity = create([
        { method: "GET", path: "/files/:name", route: "parameter" },
        {
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
          route: "mixed",
        },
        { method: "GET", path: "/files/index.json", route: "static" },
      ]);

      expect(routesBySpecificity.match("GET", "/files/index.json")!.route).toBe("static");
      expect(routesBySpecificity.match("GET", "/files/other.json")!.route).toBe("mixed");
      expect(routesBySpecificity.match("GET", "/files/other")!.route).toBe("parameter");
    });

    test("uses later-segment specificity across overlapping mixed branches", () => {
      const routesBySpecificity = create([
        {
          method: "GET",
          path: "/{right}b/:tail",
          routePattern: {
            segments: [
              [
                { kind: "parameter", name: "right" },
                { kind: "literal", value: "b" },
              ],
              [{ kind: "parameter", name: "tail" }],
            ],
            trailingSlash: false,
          },
          route: "mixedThenParameter",
        },
        {
          method: "GET",
          path: "/a{left}/fixed",
          routePattern: {
            segments: [
              [
                { kind: "literal", value: "a" },
                { kind: "parameter", name: "left" },
              ],
              [{ kind: "literal", value: "fixed" }],
            ],
            trailingSlash: false,
          },
          route: "mixedThenStatic",
        },
      ]);

      const matched = routesBySpecificity.match("GET", "/ab/fixed");
      expect(matched!.route).toBe("mixedThenStatic");
      expect(matched!.pathParams).toEqual({ left: "b" });
    });

    test("uses parameter names from the matched route", () => {
      const m = create([
        { method: "GET", path: "/:id/a", route: "a" },
        { method: "GET", path: "/:name/b", route: "b" },
      ]);

      expect(m.match("GET", "/first/a")!.pathParams).toEqual({ id: "first" });
      expect(m.match("GET", "/second/b")!.pathParams).toEqual({ name: "second" });
    });

    test("canonicalizes percent escapes before applying static-route precedence", () => {
      const canonical = create([
        { method: "GET", path: "/pets/:id", route: "parameter" },
        { method: "GET", path: "/pets/new", route: "static" },
        { method: "GET", path: "/café", route: "unicode" },
        { method: "GET", path: "/reserved/:value", route: "reservedParameter" },
        { method: "GET", path: "/reserved/%2F", route: "reservedStatic" },
      ]);

      expect(canonical.match("GET", "/pets/%6Eew")!.route).toBe("static");
      expect(canonical.match("GET", "/pets/%6eew")!.route).toBe("static");
      expect(canonical.match("GET", "/caf%C3%A9")!.route).toBe("unicode");
      expect(canonical.match("GET", "/caf%c3%a9")!.route).toBe("unicode");
      expect(canonical.match("GET", "/reserved/%2f")!.route).toBe("reservedStatic");
      expect(canonical.match("GET", "/reserved/%252F")!.route).toBe("reservedParameter");
      expect(canonical.match("GET", "/caf%C3%A9/")).toBeNull();
    });

    test("preserves raw captures across canonical embedded-literal boundaries", () => {
      const canonical = create([
        {
          method: "GET",
          path: "/files/pre-{id}-post",
          routePattern: {
            segments: [
              [{ kind: "literal", value: "files" }],
              [
                { kind: "literal", value: "pre-" },
                { kind: "parameter", name: "id" },
                { kind: "literal", value: "-post" },
              ],
            ],
            trailingSlash: false,
          },
          route: "embedded",
        },
        {
          method: "GET",
          path: "/pairs/{left}:{right}",
          routePattern: {
            segments: [
              [{ kind: "literal", value: "pairs" }],
              [
                { kind: "parameter", name: "left" },
                { kind: "literal", value: ":" },
                { kind: "parameter", name: "right" },
              ],
            ],
            trailingSlash: false,
          },
          route: "pair",
        },
        { method: "GET", path: "/pairs/:value", route: "pairFallback" },
        {
          method: "GET",
          path: "/emoji/🐱{name}",
          routePattern: {
            segments: [
              [{ kind: "literal", value: "emoji" }],
              [
                { kind: "literal", value: "🐱" },
                { kind: "parameter", name: "name" },
              ],
            ],
            trailingSlash: false,
          },
          route: "emoji",
        },
      ]);

      expect(canonical.match("GET", "/files/%70re-%6Eew-%70ost")!.pathParams).toEqual({
        id: "%6Eew",
      });
      expect(canonical.match("GET", "/pairs/left%3aright:tail")!.pathParams).toEqual({
        left: "left%3aright",
        right: "tail",
      });
      const reservedData = canonical.match("GET", "/pairs/left%3Aright");
      expect(reservedData!.route).toBe("pairFallback");
      expect(reservedData!.pathParams).toEqual({ value: "left%3Aright" });
      expect(canonical.match("GET", "/emoji/%f0%9f%90%b1%6Eew")!.pathParams).toEqual({
        name: "%6Eew",
      });
    });

    // --- Param values with special characters ---

    test("param with dots, hyphens", () => {
      expect(matcher.match("GET", "/pets/v1.2-beta")!.pathParams).toEqual({ petId: "v1.2-beta" });
    });

    test("param with percent-encoding (opaque, not decoded)", () => {
      expect(matcher.match("GET", "/pets/hello%20world")!.pathParams).toEqual({
        petId: "hello%20world",
      });
      expect(matcher.match("GET", "/pets/caf%C3%A9")!.pathParams).toEqual({
        petId: "caf%C3%A9",
      });
      expect(matcher.match("GET", "/pets/%ZZ")!.pathParams).toEqual({ petId: "%ZZ" });
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

    test("structured routes match root and non-root trailing slashes exactly", () => {
      const exact = create([
        {
          method: "GET",
          path: "/",
          routePattern: { segments: [], trailingSlash: true },
          route: "root",
        },
        {
          method: "GET",
          path: "/pets",
          routePattern: {
            segments: [[{ kind: "literal", value: "pets" }]],
            trailingSlash: false,
          },
          route: "withoutSlash",
        },
        {
          method: "GET",
          path: "/pets/",
          routePattern: {
            segments: [[{ kind: "literal", value: "pets" }]],
            trailingSlash: true,
          },
          route: "withSlash",
        },
      ]);

      expect(exact.match("GET", "/")!.route).toBe("root");
      expect(exact.match("GET", "/pets")!.route).toBe("withoutSlash");
      expect(exact.match("GET", "/pets/")!.route).toBe("withSlash");
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

    test("dispatches shared routes by pairwise-disjoint required headers", () => {
      const routes = [
        {
          method: "GET",
          path: "/reports/:reportId",
          selection: {
            headers: [{ name: "x-view", values: ["detailed"] }],
          },
          route: "detailed",
        },
        {
          method: "GET",
          path: "/reports/:id",
          selection: {
            headers: [{ name: "X-View", values: ["summary"] }],
          },
          route: "summary",
        },
      ];

      for (const ordered of [routes, [...routes].reverse()]) {
        const shared = create(ordered);
        expect(shared.match("GET", "/reports/r-1", new Headers({ "x-view": "summary" }))).toEqual({
          route: "summary",
          pathParams: { id: "r-1" },
        });
        expect(shared.match("GET", "/reports/r-1", new Headers({ "x-view": "detailed" }))).toEqual({
          route: "detailed",
          pathParams: { reportId: "r-1" },
        });
        expect(shared.match("GET", "/reports/r-1", new Headers())).toBeNull();
      }
    });

    test("dispatches shared routes using media-type semantics", () => {
      const shared = create([
        {
          method: "POST",
          path: "/documents",
          selection: {
            headers: [{ name: "content-type", values: ["application/*"], kind: "media-type" }],
          },
          route: "structured",
        },
        {
          method: "POST",
          path: "/documents",
          selection: {
            headers: [{ name: "content-type", values: ["text/plain"], kind: "media-type" }],
          },
          route: "text",
        },
      ]);

      expect(
        shared.match(
          "POST",
          "/documents",
          new Headers({ "content-type": "Application/JSON; charset=utf-8" }),
        )?.route,
      ).toBe("structured");
      expect(
        shared.match("POST", "/documents", new Headers({ "content-type": "text/plain" }))?.route,
      ).toBe("text");
    });

    test("rejects overlapping shared-route constraints with both route identities", () => {
      expect(() =>
        create([
          {
            method: "POST",
            path: "/documents",
            label: "Documents.acceptAnyApplication",
            selection: {
              headers: [{ name: "content-type", values: ["application/*"], kind: "media-type" }],
            },
            route: "application",
          },
          {
            method: "POST",
            path: "/documents",
            label: "Documents.acceptJson",
            selection: {
              headers: [{ name: "content-type", values: ["application/json"], kind: "media-type" }],
            },
            route: "json",
          },
        ]),
      ).toThrow(
        "Duplicate route: POST /documents (Documents.acceptJson) conflicts with POST /documents (Documents.acceptAnyApplication)",
      );
    });

    test("reports malformed shared-route selectors with route context", () => {
      expect(() =>
        create([
          {
            method: "GET",
            path: "/reports",
            selection: { headers: [{}] },
            route: "invalid",
          } as any,
        ]),
      ).toThrow("Invalid route selection: GET /reports");
    });

    test("rejects static routes that are equivalent after path canonicalization", () => {
      for (const paths of [
        ["/café", "/caf%C3%A9"],
        ["/pets/new", "/pets/%6eew"],
        ["/reserved/%2F", "/reserved/%2f"],
      ]) {
        expect(() =>
          create([
            { method: "GET", path: paths[0]!, route: "first" },
            { method: "GET", path: paths[1]!, route: "second" },
          ]),
        ).toThrow(`Duplicate route: GET ${paths[1]}`);
      }
    });

    test("rejects canonical-equivalent literals in structured routes", () => {
      const suffix = (literal: string, route: string) => ({
        method: "GET",
        path: `/files/{id}${literal}`,
        routePattern: {
          segments: [
            [{ kind: "literal" as const, value: "files" }],
            [
              { kind: "parameter" as const, name: "id" },
              { kind: "literal" as const, value: literal },
            ],
          ],
          trailingSlash: false,
        },
        route,
      });

      expect(() => create([suffix(".json", "literal"), suffix("%2Ejson", "encoded")])).toThrow(
        "Duplicate route: GET /files/{id}%2Ejson",
      );
    });

    test("rejects structurally duplicate embedded routes with renamed params", () => {
      expect(() =>
        create([
          {
            method: "GET",
            path: "/files/{first}.json",
            routePattern: {
              segments: [
                [{ kind: "literal", value: "files" }],
                [
                  { kind: "parameter", name: "first" },
                  { kind: "literal", value: ".json" },
                ],
              ],
              trailingSlash: false,
            },
            route: "first",
          },
          {
            method: "GET",
            path: "/files/{second}.json",
            routePattern: {
              segments: [
                [{ kind: "literal", value: "files" }],
                [
                  { kind: "parameter", name: "second" },
                  { kind: "literal", value: ".json" },
                ],
              ],
              trailingSlash: false,
            },
            route: "second",
          },
        ]),
      ).toThrow("Duplicate route: GET /files/{second}.json");
    });

    test("rejects overlapping same-precedence mixed routes and allows disjoint ones", () => {
      const suffix = (name: string, literal: string) => ({
        segments: [
          [
            { kind: "parameter" as const, name },
            { kind: "literal" as const, value: literal },
          ],
        ],
        trailingSlash: false,
      });
      expect(() =>
        create([
          {
            method: "GET",
            path: "/a{left}",
            routePattern: {
              segments: [
                [
                  { kind: "literal", value: "a" },
                  { kind: "parameter", name: "left" },
                ],
              ],
              trailingSlash: false,
            },
            route: "left",
          },
          {
            method: "GET",
            path: "/{right}b",
            routePattern: suffix("right", "b"),
            route: "right",
          },
        ]),
      ).toThrow("Ambiguous route");

      expect(() =>
        create([
          {
            method: "GET",
            path: "/{id}.json",
            routePattern: suffix("id", ".json"),
            route: "json",
          },
          {
            method: "GET",
            path: "/{id}.txt",
            routePattern: suffix("id", ".txt"),
            route: "text",
          },
        ]),
      ).not.toThrow();
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

    test("validates structured segment tokens and root trailing-slash semantics", () => {
      const invalidPatterns = [
        null,
        { segments: [], trailingSlash: false },
        { segments: [[]], trailingSlash: false },
        {
          segments: [[{ kind: "literal", value: "bad/segment" }]],
          trailingSlash: false,
        },
        {
          segments: [
            [
              { kind: "parameter", name: "one" },
              { kind: "parameter", name: "two" },
            ],
          ],
          trailingSlash: false,
        },
        {
          segments: [
            [
              { kind: "parameter", name: "name" },
              { kind: "literal", value: "." },
              { kind: "parameter", name: "extension" },
            ],
          ],
          trailingSlash: false,
        },
        {
          segments: [[{ kind: "parameter", name: "same" }], [{ kind: "parameter", name: "same" }]],
          trailingSlash: false,
        },
      ];
      for (const routePattern of invalidPatterns) {
        expect(() =>
          create([
            {
              method: "GET",
              path: "/invalid",
              routePattern: routePattern as never,
              route: "invalid",
            },
          ]),
        ).toThrow();
      }
    });

    test("rejects duplicate parameter names in one route", () => {
      expect(() =>
        create([{ method: "GET", path: "/teams/:id/members/:id", route: "invalid" }]),
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
