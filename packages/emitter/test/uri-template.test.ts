import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildEmitter,
  cleanupFixtures,
  compileFixture,
  compileFixtureExpectingDiagnostics,
} from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

function emittedRoutePattern(source: string, path: string): unknown {
  return emittedRouteProperty(source, path, "routePattern:");
}

function emittedRoutePatterns(source: string, path: string): unknown {
  return emittedRouteProperty(source, path, "routePatterns:");
}

function emittedRouteProperty(source: string, path: string, marker: string): unknown {
  const pathOffset = source.indexOf(`path: ${JSON.stringify(path)},`);
  expect(pathOffset).toBeGreaterThanOrEqual(0);
  const patternOffset = source.indexOf(marker, pathOffset);
  const hintsOffset = source.indexOf("hints:", patternOffset);
  expect(patternOffset).toBeGreaterThan(pathOffset);
  expect(hintsOffset).toBeGreaterThan(patternOffset);
  const expression = source
    .slice(patternOffset + marker.length, hintsOffset)
    .trim()
    .replace(/,$/, "");
  return Function(`"use strict"; return (${expression});`)();
}

const supportedUriTemplatesSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "UriTemplateApi" })
namespace UriTemplateApi;

@route("/suffix/{id}.json")
@get op suffix(@path id: string): void;

@route("/prefix/pre-{id}-post")
@get op prefix(@path id: string): void;

@route("/renamed/file-{wire}.txt")
@get op renamed(@path("wire") local: string): void;

@route("/pairs/{left}:{right}")
@get op pair(@path left: string, @path right: string): void;

@route("/comma/{first,second}")
@get op comma(@path first: string, @path second: string): void;

@route("/raw/{value}")
@get op raw(@path value: string): void;

@route("/trail/")
@get op trail(): void;

@route("/query/{id}")
@get op query(
  @path id: string,
  @query(#{ name: "tags", explode: true }) tags?: string[],
): void;

@route("/optional{/name}")
@get op optional(@path name?: string): void;

@route("/required{/name}")
@get op required(@path name: string): void;

@route("/required-explode{/name*}")
@get op requiredExplode(@path name: string): void;
`;

const unsupportedUriTemplatesSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "InvalidUriTemplateApi" })
namespace InvalidUriTemplateApi;

@route("/adjacent/{x}{y}")
@get op adjacent(@path x: string, @path y: string): void;

@route("/unreserved/{x}-{y}")
@get op unreserved(@path x: string, @path y: string): void;

@route("/explode/{x*}")
@get op explode(@path x: string): void;

@route("/prefix-modifier/{x:2}")
@get op prefixModifier(@path x: string): void;

@route("/reserved/{+x}")
@get op reservedOperator(@path x: string): void;

@route("/repeated/{x}/{x}")
@get op repeated(@path x: string): void;

@route("/collection/{x,y}")
@get op collectionExpansion(@path x: string[], @path y: string): void;

@route("/literal-comma/{left},{right}")
@get op literalComma(@path left: string[], @path right: string): void;

@route("/malformed/{value")
@get op malformed(@path value: string): void;

@route("/after-query/{x}{?q}/tail")
@get op afterQuery(@path x: string, @query q?: string): void;
`;

const unknownUriVariableSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "UnknownUriVariableApi" })
namespace UnknownUriVariableApi;

@route("/unknown/{other}")
@get op read(@path value: string): void;
`;

describe("URI-template lowering", () => {
  test("emits structured routes and routes embedded variables without losing wire names", async () => {
    const result = compileFixture("uri-template-supported", supportedUriTemplatesSpec);
    const operations = result.readFile("uri-template-api", "server-operations.ts");

    expect(emittedRoutePattern(operations, "/suffix/{id}.json")).toEqual({
      segments: [
        [{ kind: "literal", value: "suffix" }],
        [
          { kind: "parameter", name: "id" },
          { kind: "literal", value: ".json" },
        ],
      ],
      trailingSlash: false,
    });
    expect(emittedRoutePattern(operations, "/renamed/file-{wire}.txt")).toEqual({
      segments: [
        [{ kind: "literal", value: "renamed" }],
        [
          { kind: "literal", value: "file-" },
          { kind: "parameter", name: "wire" },
          { kind: "literal", value: ".txt" },
        ],
      ],
      trailingSlash: false,
    });
    expect(emittedRoutePattern(operations, "/pairs/{left}:{right}")).toEqual({
      segments: [
        [{ kind: "literal", value: "pairs" }],
        [
          { kind: "parameter", name: "left" },
          { kind: "literal", value: ":" },
          { kind: "parameter", name: "right" },
        ],
      ],
      trailingSlash: false,
    });
    expect(emittedRoutePattern(operations, "/comma/{first,second}")).toEqual({
      segments: [
        [{ kind: "literal", value: "comma" }],
        [
          { kind: "parameter", name: "first" },
          { kind: "literal", value: "," },
          { kind: "parameter", name: "second" },
        ],
      ],
      trailingSlash: false,
    });
    expect(emittedRoutePattern(operations, "/trail/")).toEqual({
      segments: [[{ kind: "literal", value: "trail" }]],
      trailingSlash: true,
    });
    expect(emittedRoutePatterns(operations, "/optional{/name}")).toEqual([
      {
        segments: [[{ kind: "literal", value: "optional" }]],
        trailingSlash: false,
      },
      {
        segments: [[{ kind: "literal", value: "optional" }], [{ kind: "parameter", name: "name" }]],
        trailingSlash: false,
      },
    ]);
    expect(emittedRoutePattern(operations, "/required{/name}")).toEqual({
      segments: [[{ kind: "literal", value: "required" }], [{ kind: "parameter", name: "name" }]],
      trailingSlash: false,
    });
    expect(emittedRoutePattern(operations, "/required-explode{/name*}")).toEqual({
      segments: [
        [{ kind: "literal", value: "required-explode" }],
        [{ kind: "parameter", name: "name" }],
      ],
      trailingSlash: false,
    });
    expect(operations).toContain('path: "/query/{id}"');
    expect(operations).not.toContain("{?tags");
    result.typecheck("uri-template-api");

    const { createUriTemplateApiServerRouter } = await import(
      `${result.outputDir}/uri-template-api/server-router.ts`
    );
    const received = new Map<string, unknown>();
    const capture = (name: string) => (input: unknown) => {
      received.set(name, input);
    };
    const router = createUriTemplateApiServerRouter({
      suffix: capture("suffix"),
      prefix: capture("prefix"),
      renamed: capture("renamed"),
      pair: capture("pair"),
      comma: capture("comma"),
      raw: capture("raw"),
      trail: capture("trail"),
      query: capture("query"),
      optional: capture("optional"),
      required: capture("required"),
      requiredExplode: capture("requiredExplode"),
    } as any);

    expect((await router.handle(new Request("http://localhost/suffix/example.json"))).status).toBe(
      204,
    );
    expect(received.get("suffix")).toEqual({ id: "example" });
    expect((await router.handle(new Request("http://localhost/suffix/example.xml"))).status).toBe(
      404,
    );

    expect(
      (await router.handle(new Request("http://localhost/prefix/pre-value-post"))).status,
    ).toBe(204);
    expect(received.get("prefix")).toEqual({ id: "value" });

    expect(
      (await router.handle(new Request("http://localhost/renamed/file-wire-value.txt"))).status,
    ).toBe(204);
    expect(received.get("renamed")).toEqual({ local: "wire-value" });

    expect((await router.handle(new Request("http://localhost/pairs/left:right"))).status).toBe(
      204,
    );
    expect(received.get("pair")).toEqual({ left: "left", right: "right" });

    expect((await router.handle(new Request("http://localhost/comma/one,two"))).status).toBe(204);
    expect(received.get("comma")).toEqual({ first: "one", second: "two" });

    expect((await router.handle(new Request("http://localhost/raw/a%252Fb"))).status).toBe(204);
    expect(received.get("raw")).toEqual({ value: "a%2Fb" });
    expect((await router.handle(new Request("http://localhost/raw/a%2Fb"))).status).toBe(204);
    expect(received.get("raw")).toEqual({ value: "a/b" });
    expect((await router.handle(new Request("http://localhost/raw/%ZZ"))).status).toBe(400);

    expect((await router.handle(new Request("http://localhost/trail/"))).status).toBe(204);
    expect((await router.handle(new Request("http://localhost/trail"))).status).toBe(404);

    expect(
      (await router.handle(new Request("http://localhost/query/item?tags=one&tags=two"))).status,
    ).toBe(204);
    expect(received.get("query")).toEqual({ id: "item", tags: ["one", "two"] });

    expect((await router.handle(new Request("http://localhost/optional"))).status).toBe(204);
    expect(received.get("optional")).toEqual({ name: undefined });
    expect((await router.handle(new Request("http://localhost/optional/value"))).status).toBe(204);
    expect(received.get("optional")).toEqual({ name: "value" });
    expect((await router.handle(new Request("http://localhost/optional/"))).status).toBe(404);

    expect((await router.handle(new Request("http://localhost/required/value"))).status).toBe(204);
    expect(received.get("required")).toEqual({ name: "value" });
    expect((await router.handle(new Request("http://localhost/required"))).status).toBe(404);
    expect((await router.handle(new Request("http://localhost/required/"))).status).toBe(404);

    expect(
      (await router.handle(new Request("http://localhost/required-explode/a%2Fb"))).status,
    ).toBe(204);
    expect(received.get("requiredExplode")).toEqual({ name: "a/b" });
  });

  test("reports unsafe path expressions before writing generated files", () => {
    const result = compileFixtureExpectingDiagnostics(
      "uri-template-unsupported",
      unsupportedUriTemplatesSpec,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("adjacent path variables cannot be captured unambiguously");
    expect(diagnostics).toContain(
      'path variables separated by unreserved literal "-" cannot be captured unambiguously',
    );
    expect(diagnostics).toContain('modifier "*"');
    expect(diagnostics).toContain('modifier ":2"');
    expect(diagnostics).toContain('operator "+"');
    expect(diagnostics).toContain("appears more than once");
    expect(diagnostics).toContain(
      'path variables separated only by commas require scalar variables, but "x" has a collection shape',
    );
    expect(diagnostics).toContain(
      'path variables separated only by commas require scalar variables, but "left" has a collection shape',
    );
    expect(diagnostics).toContain("nested '{'");
    expect(diagnostics).toContain("path material appears after a query expansion");
    expect(result.listFiles("invalid-uri-template-api")).toEqual([]);
  });

  test("unknown URI variables fail before emission", () => {
    const result = compileFixtureExpectingDiagnostics(
      "uri-template-unknown-variable",
      unknownUriVariableSpec,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;

    expect(diagnostics).toContain("@typespec/http/missing-uri-param");
    expect(diagnostics).toContain("Route reference parameter 'other'");
    expect(result.listFiles("unknown-uri-variable-api")).toEqual([]);
  });

  test("strict parser rejects malformed and unknown expressions", async () => {
    const { lowerUriTemplateText } = await import("../dist/uri-template.js");
    const path = new Set(["x"]);
    const query = new Set<string>();

    expect(lowerUriTemplateText("/malformed/{x", path, query)).toEqual({
      ok: false,
      reason: "unclosed '{' at offset 11",
    });
    expect(lowerUriTemplateText("/malformed/{x/{x}", path, query)).toEqual({
      ok: false,
      reason: "nested '{' at offset 14",
    });
    expect(lowerUriTemplateText("/unknown/{other}", path, query)).toEqual({
      ok: false,
      reason: 'unknown path variable "other"',
    });
    expect(lowerUriTemplateText("/required{/x}", path, query)).toEqual({
      ok: true,
      value: {
        path: "/required{/x}",
        routePatterns: [
          {
            segments: [
              [{ kind: "literal", value: "required" }],
              [{ kind: "parameter", name: "x" }],
            ],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(lowerUriTemplateText("/required{/x*}", path, query)).toEqual({
      ok: true,
      value: {
        path: "/required{/x*}",
        routePatterns: [
          {
            segments: [
              [{ kind: "literal", value: "required" }],
              [{ kind: "parameter", name: "x" }],
            ],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(lowerUriTemplateText("/optional{/x}", path, query, path, new Set(["x"]))).toEqual({
      ok: true,
      value: {
        path: "/optional{/x}",
        routePatterns: [
          {
            segments: [[{ kind: "literal", value: "optional" }]],
            trailingSlash: false,
          },
          {
            segments: [
              [{ kind: "literal", value: "optional" }],
              [{ kind: "parameter", name: "x" }],
            ],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(lowerUriTemplateText("/optional{/x}/tail", path, query, path, new Set(["x"]))).toEqual({
      ok: false,
      reason: "path material appears after an optional slash expansion",
    });
    expect(lowerUriTemplateText("/optional{/x*}", path, query, path, new Set(["x"]))).toEqual({
      ok: false,
      reason: "exploded optional slash expansions are not supported",
    });
    expect(lowerUriTemplateText("/required/{/x}", path, query)).toEqual({
      ok: false,
      reason: "a slash expansion must follow a non-empty path segment",
    });
    expect(lowerUriTemplateText("/required{/x:2}", path, query)).toEqual({
      ok: false,
      reason: 'modifier ":2" on path variable "x" is not supported',
    });
    expect(lowerUriTemplateText("/required{/x}", path, query, new Set())).toEqual({
      ok: false,
      reason: 'slash-expanded path variable "x" must have a scalar wire shape',
    });
    expect(
      lowerUriTemplateText(
        "/optional{/x,y}",
        new Set(["x", "y"]),
        query,
        new Set(["x", "y"]),
        new Set(["x", "y"]),
      ),
    ).toEqual({
      ok: false,
      reason: "slash expansions must contain exactly one path variable",
    });
    expect(lowerUriTemplateText("/query/{x}{?q*}", path, new Set(["q"]))).toEqual({
      ok: true,
      value: {
        path: "/query/{x}",
        routePatterns: [
          {
            segments: [[{ kind: "literal", value: "query" }], [{ kind: "parameter", name: "x" }]],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(lowerUriTemplateText("/same-wire/{id}{?id}", new Set(["id"]), new Set(["id"]))).toEqual({
      ok: true,
      value: {
        path: "/same-wire/{id}",
        routePatterns: [
          {
            segments: [
              [{ kind: "literal", value: "same-wire" }],
              [{ kind: "parameter", name: "id" }],
            ],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(
      lowerUriTemplateText("/mixed/{x}-:{y}", new Set(["x", "y"]), new Set(), new Set()),
    ).toEqual({
      ok: true,
      value: {
        path: "/mixed/{x}-:{y}",
        routePatterns: [
          {
            segments: [
              [{ kind: "literal", value: "mixed" }],
              [
                { kind: "parameter", name: "x" },
                { kind: "literal", value: "-:" },
                { kind: "parameter", name: "y" },
              ],
            ],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(
      lowerUriTemplateText("/brackets/{x}[v]{y}", new Set(["x", "y"]), new Set(), new Set()),
    ).toEqual({
      ok: true,
      value: {
        path: "/brackets/{x}[v]{y}",
        routePatterns: [
          {
            segments: [
              [{ kind: "literal", value: "brackets" }],
              [
                { kind: "parameter", name: "x" },
                { kind: "literal", value: "[v]" },
                { kind: "parameter", name: "y" },
              ],
            ],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(
      lowerUriTemplateText(
        "/literal-comma/{x},{y}",
        new Set(["x", "y"]),
        new Set(),
        new Set(["y"]),
      ),
    ).toEqual({
      ok: false,
      reason:
        'path variables separated only by commas require scalar variables, but "x" has a collection shape',
    });
  });
});
