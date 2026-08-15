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

@route("/reserved/template/{+value}")
@get op reservedTemplate(
  // Intentionally implicit to mirror the upstream template-authored scenario.
  value: string,
): void;

@route("/reserved/annotation")
@get op reservedAnnotation(@path(#{ allowReserved: true }) value: string): void;

@route("/trail/")
@get op trail(): void;

@route("/query/{id}")
@get op query(
  @path id: string,
  @query(#{ name: "tags", explode: true }) tags?: string[],
): void;

@route("/query-record{?param}")
@get op queryRecord(param: Record<int32>): void;

@route("/query-record-explode{?param*,tag}")
@get op queryRecordExplode(param: Record<int32>, tag?: string): void;

@route("/optional{/name}")
@get op optional(@path name?: string): void;

@route("/required{/name}")
@get op required(@path name: string): void;

@route("/required-explode{/name*}")
@get op requiredExplode(@path name: string): void;

@route("/slash-array/array{/param}")
@get op slashArray(@path param: string[]): void;

@route("/slash-record/record{/param}")
@get op slashRecord(@path param: Record<int32>): void;

@route("/slash-array-explode/array{/param*}")
@get op slashArrayExplode(@path param: string[]): void;

@route("/slash-record-explode/record{/param*}")
@get op slashRecordExplode(@path param: Record<int32>): void;

@route("/simple-explode/item{name*}")
@get op simpleExplode(@path name: string): void;

@route("/simple-array/array{param*}")
@get op simpleArray(@path param: string[]): void;

@route("/simple-record/record{param}")
@get op simpleRecord(@path param: Record<int32>): void;

@route("/simple-record-explode/record{param*}")
@get op simpleRecordExplode(@path param: Record<int32>): void;

@route("/label/item{.name}")
@get op label(@path name: string): void;

@route("/label-explode/item{.name*}")
@get op labelExplode(@path name: string): void;

@route("/label-array/array{.param}")
@get op labelArray(@path param: string[]): void;

@route("/label-array-explode/array{.param*}")
@get op labelArrayExplode(@path param: string[]): void;

@route("/label-record/record{.param}")
@get op labelRecord(@path param: Record<int32>): void;

@route("/label-record-explode/record{.param*}")
@get op labelRecordExplode(@path param: Record<int32>): void;

@route("/label-record-segment/{.param}")
@get op labelRecordSegment(@path param: Record<int32>): void;

@route("/matrix/item{;name}")
@get op matrix(@path name: string): void;

@route("/matrix-explode/item{;name*}")
@get op matrixExplode(@path name: string): void;

@route("/matrix-array/array{;param}")
@get op matrixArray(@path param: string[]): void;

@route("/matrix-array-explode/array{;param*}")
@get op matrixArrayExplode(@path param: string[]): void;

@route("/matrix-record/record{;param}")
@get op matrixRecord(@path param: Record<int32>): void;

@route("/matrix-record-explode/record{;param*}")
@get op matrixRecordExplode(@path param: Record<int32>): void;
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
@get op explode(@path x: Record<string[]>): void;

@route("/prefix-modifier/{x:2}")
@get op prefixModifier(@path x: string): void;

@route("/reserved/prefix{+x}")
@get op embeddedReserved(@path x: string): void;

@route("/reserved/{+tail}/suffix")
@get op nonterminalReserved(@path tail: string): void;

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

@route("/label-optional/item{.x}")
@get op optionalLabel(@path x?: string): void;

@route("/label-record/item{.x}")
@get op recordLabel(@path x: Record<string[]>): void;

@route("/label-record-shared/{left}:{.right}")
@get op sharedRecordLabel(@path left: string, @path right: Record<int32>): void;

@route("/label-multiple/item{.x,y}")
@get op multipleLabel(@path x: string, @path y: string): void;

@route("/matrix-optional/item{;x}")
@get op optionalMatrix(@path x?: string): void;

@route("/matrix-record/item{;x}")
@get op recordMatrix(@path x: Record<string[]>): void;

@route("/matrix-multiple/item{;x,y}")
@get op multipleMatrix(@path x: string, @path y: string): void;

@route("/slash-array-nonterminal/array{/x*}/tail")
@get op nonterminalSlashArray(@path x: string[]): void;

@route("/slash-array-optional/array{/x}")
@get op optionalSlashArray(@path x?: string[]): void;

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
    expect(emittedRoutePattern(operations, "/reserved/template/{+value}")).toEqual({
      segments: [
        [{ kind: "literal", value: "reserved" }],
        [{ kind: "literal", value: "template" }],
        [{ kind: "rest", name: "value" }],
      ],
      trailingSlash: false,
    });
    expect(emittedRoutePattern(operations, "/reserved/annotation/{+value}")).toEqual({
      segments: [
        [{ kind: "literal", value: "reserved" }],
        [{ kind: "literal", value: "annotation" }],
        [{ kind: "rest", name: "value" }],
      ],
      trailingSlash: false,
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
    expect(emittedRoutePattern(operations, "/slash-array/array{/param}")).toEqual({
      segments: [
        [{ kind: "literal", value: "slash-array" }],
        [{ kind: "literal", value: "array" }],
        [{ kind: "parameter", name: "param" }],
      ],
      trailingSlash: false,
    });
    expect(emittedRoutePattern(operations, "/slash-record/record{/param}")).toEqual({
      segments: [
        [{ kind: "literal", value: "slash-record" }],
        [{ kind: "literal", value: "record" }],
        [{ kind: "parameter", name: "param" }],
      ],
      trailingSlash: false,
    });
    expect(operations).toMatch(
      /slashRecord: RequestDecoders\.path\(\s*"param",\s*Decoders\.record\([\s\S]*?\),\s*\{ record: true \},\s*\)\.map/,
    );
    expect(emittedRoutePattern(operations, "/slash-array-explode/array{/param*}")).toEqual({
      segments: [
        [{ kind: "literal", value: "slash-array-explode" }],
        [{ kind: "literal", value: "array" }],
        [{ kind: "rest", name: "param" }],
      ],
      trailingSlash: false,
    });
    expect(emittedRoutePattern(operations, "/slash-record-explode/record{/param*}")).toEqual({
      segments: [
        [{ kind: "literal", value: "slash-record-explode" }],
        [{ kind: "literal", value: "record" }],
        [{ kind: "rest", name: "param" }],
      ],
      trailingSlash: false,
    });
    expect(operations).toMatch(
      /slashRecordExplode: RequestDecoders\.path\(\s*"param",\s*Decoders\.record\([\s\S]*?\),\s*\{ record: true, explode: true, recordSeparator: "\/" \},\s*\)\.map/,
    );
    expect(emittedRoutePattern(operations, "/simple-explode/item{name*}")).toEqual({
      segments: [
        [{ kind: "literal", value: "simple-explode" }],
        [
          { kind: "literal", value: "item" },
          { kind: "parameter", name: "name" },
        ],
      ],
      trailingSlash: false,
    });
    expect(emittedRoutePattern(operations, "/simple-array/array{param*}")).toEqual({
      segments: [
        [{ kind: "literal", value: "simple-array" }],
        [
          { kind: "literal", value: "array" },
          { kind: "parameter", name: "param" },
        ],
      ],
      trailingSlash: false,
    });
    expect(emittedRoutePattern(operations, "/simple-record/record{param}")).toEqual({
      segments: [
        [{ kind: "literal", value: "simple-record" }],
        [
          { kind: "literal", value: "record" },
          { kind: "parameter", name: "param" },
        ],
      ],
      trailingSlash: false,
    });
    expect(operations).toMatch(
      /simpleRecord: RequestDecoders\.path\(\s*"param",\s*Decoders\.record\([\s\S]*?\),\s*\{ record: true \},\s*\)\.map/,
    );
    expect(emittedRoutePattern(operations, "/simple-record-explode/record{param*}")).toEqual({
      segments: [
        [{ kind: "literal", value: "simple-record-explode" }],
        [
          { kind: "literal", value: "record" },
          { kind: "parameter", name: "param" },
        ],
      ],
      trailingSlash: false,
    });
    expect(operations).toMatch(
      /simpleRecordExplode: RequestDecoders\.path\(\s*"param",\s*Decoders\.record\([\s\S]*?\),\s*\{ record: true, explode: true \},\s*\)\.map/,
    );
    expect(emittedRoutePattern(operations, "/label/item{.name}")).toEqual({
      segments: [
        [{ kind: "literal", value: "label" }],
        [
          { kind: "literal", value: "item." },
          { kind: "parameter", name: "name" },
        ],
      ],
      trailingSlash: false,
    });
    expect(emittedRoutePattern(operations, "/label-explode/item{.name*}")).toEqual({
      segments: [
        [{ kind: "literal", value: "label-explode" }],
        [
          { kind: "literal", value: "item." },
          { kind: "parameter", name: "name" },
        ],
      ],
      trailingSlash: false,
    });
    expect(emittedRoutePattern(operations, "/label-array/array{.param}")).toEqual({
      segments: [
        [{ kind: "literal", value: "label-array" }],
        [
          { kind: "literal", value: "array." },
          { kind: "parameter", name: "param" },
        ],
      ],
      trailingSlash: false,
    });
    expect(emittedRoutePattern(operations, "/label-array-explode/array{.param*}")).toEqual({
      segments: [
        [{ kind: "literal", value: "label-array-explode" }],
        [
          { kind: "literal", value: "array." },
          { kind: "parameter", name: "param" },
        ],
      ],
      trailingSlash: false,
    });
    expect(emittedRoutePatterns(operations, "/label-record/record{.param}")).toEqual([
      {
        segments: [
          [{ kind: "literal", value: "label-record" }],
          [
            { kind: "literal", value: "record." },
            { kind: "parameter", name: "param" },
          ],
        ],
        trailingSlash: false,
      },
      {
        segments: [
          [{ kind: "literal", value: "label-record" }],
          [{ kind: "literal", value: "record" }],
        ],
        trailingSlash: false,
      },
    ]);
    expect(operations).toMatch(
      /labelRecord: RequestDecoders\.path\(\s*"param",\s*Decoders\.record\([\s\S]*?\),\s*\{ record: true, emptyComposite: true \},\s*\)\.map/,
    );
    expect(emittedRoutePatterns(operations, "/label-record-explode/record{.param*}")).toEqual([
      {
        segments: [
          [{ kind: "literal", value: "label-record-explode" }],
          [
            { kind: "literal", value: "record." },
            { kind: "parameter", name: "param" },
          ],
        ],
        trailingSlash: false,
      },
      {
        segments: [
          [{ kind: "literal", value: "label-record-explode" }],
          [{ kind: "literal", value: "record" }],
        ],
        trailingSlash: false,
      },
    ]);
    expect(operations).toMatch(
      /labelRecordExplode: RequestDecoders\.path\(\s*"param",\s*Decoders\.record\([\s\S]*?\),\s*\{ record: true, emptyComposite: true, explode: true, recordSeparator: "\." \},\s*\)\.map/,
    );
    expect(emittedRoutePattern(operations, "/matrix/item{;name}")).toEqual({
      segments: [
        [{ kind: "literal", value: "matrix" }],
        [
          { kind: "literal", value: "item;name=" },
          { kind: "parameter", name: "name" },
        ],
      ],
      trailingSlash: false,
    });
    expect(emittedRoutePattern(operations, "/matrix-explode/item{;name*}")).toEqual({
      segments: [
        [{ kind: "literal", value: "matrix-explode" }],
        [
          { kind: "literal", value: "item;name=" },
          { kind: "parameter", name: "name" },
        ],
      ],
      trailingSlash: false,
    });
    expect(emittedRoutePattern(operations, "/matrix-array/array{;param}")).toEqual({
      segments: [
        [{ kind: "literal", value: "matrix-array" }],
        [
          { kind: "literal", value: "array;param=" },
          { kind: "parameter", name: "param" },
        ],
      ],
      trailingSlash: false,
    });
    expect(emittedRoutePattern(operations, "/matrix-array-explode/array{;param*}")).toEqual({
      segments: [
        [{ kind: "literal", value: "matrix-array-explode" }],
        [
          { kind: "literal", value: "array;param=" },
          { kind: "parameter", name: "param" },
        ],
      ],
      trailingSlash: false,
    });
    expect(emittedRoutePatterns(operations, "/matrix-record/record{;param}")).toEqual([
      {
        segments: [
          [{ kind: "literal", value: "matrix-record" }],
          [
            { kind: "literal", value: "record;param=" },
            { kind: "parameter", name: "param" },
          ],
        ],
        trailingSlash: false,
      },
      {
        segments: [
          [{ kind: "literal", value: "matrix-record" }],
          [{ kind: "literal", value: "record" }],
        ],
        trailingSlash: false,
      },
    ]);
    expect(operations).toMatch(
      /matrixRecord: RequestDecoders\.path\(\s*"param",\s*Decoders\.record\([\s\S]*?\),\s*\{ record: true, emptyComposite: true \},\s*\)\.map/,
    );
    expect(emittedRoutePatterns(operations, "/matrix-record-explode/record{;param*}")).toEqual([
      {
        segments: [
          [{ kind: "literal", value: "matrix-record-explode" }],
          [
            { kind: "literal", value: "record;" },
            { kind: "parameter", name: "param" },
          ],
        ],
        trailingSlash: false,
      },
      {
        segments: [
          [{ kind: "literal", value: "matrix-record-explode" }],
          [{ kind: "literal", value: "record" }],
        ],
        trailingSlash: false,
      },
    ]);
    expect(operations).toMatch(
      /matrixRecordExplode: RequestDecoders\.path\(\s*"param",\s*Decoders\.record\([\s\S]*?\),\s*\{ record: true, emptyComposite: true, explode: true, recordSeparator: ";" \},\s*\)\.map/,
    );
    expect(operations).toContain('path: "/query/{id}"');
    expect(operations).not.toContain("{?tags");
    expect(operations).toContain('path: "/query-record"');
    expect(operations).toMatch(
      /queryRecord: RequestDecoders\.query\(\s*"param",\s*Decoders\.record\([\s\S]*?\),\s*\{ record: true, emptyComposite: true, explode: false \},\s*\)\.map/,
    );
    expect(operations).toMatch(
      /queryRecordExplode: RequestDecoders\.combine\([\s\S]*?RequestDecoders\.query\(\s*"param",\s*Decoders\.record\([\s\S]*?\),\s*\{ record: true, explode: true, excludedNames: \["tag"\] \},\s*\)[\s\S]*?RequestDecoders\.query\("tag", Decoders\.string\.optional\(\)\)[\s\S]*?\(param, tag\) => \(\{ param, tag \}\)/,
    );
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
      reservedTemplate: capture("reservedTemplate"),
      reservedAnnotation: capture("reservedAnnotation"),
      trail: capture("trail"),
      query: capture("query"),
      queryRecord: capture("queryRecord"),
      queryRecordExplode: capture("queryRecordExplode"),
      optional: capture("optional"),
      required: capture("required"),
      requiredExplode: capture("requiredExplode"),
      slashArray: capture("slashArray"),
      slashRecord: capture("slashRecord"),
      slashArrayExplode: capture("slashArrayExplode"),
      slashRecordExplode: capture("slashRecordExplode"),
      simpleExplode: capture("simpleExplode"),
      simpleArray: capture("simpleArray"),
      simpleRecord: capture("simpleRecord"),
      simpleRecordExplode: capture("simpleRecordExplode"),
      label: capture("label"),
      labelExplode: capture("labelExplode"),
      labelArray: capture("labelArray"),
      labelArrayExplode: capture("labelArrayExplode"),
      labelRecord: capture("labelRecord"),
      labelRecordExplode: capture("labelRecordExplode"),
      labelRecordSegment: capture("labelRecordSegment"),
      matrix: capture("matrix"),
      matrixExplode: capture("matrixExplode"),
      matrixArray: capture("matrixArray"),
      matrixArrayExplode: capture("matrixArrayExplode"),
      matrixRecord: capture("matrixRecord"),
      matrixRecordExplode: capture("matrixRecordExplode"),
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

    expect(
      (await router.handle(new Request("http://localhost/reserved/template/foo/bar%20baz"))).status,
    ).toBe(204);
    expect(received.get("reservedTemplate")).toEqual({ value: "foo/bar baz" });
    expect(
      (await router.handle(new Request("http://localhost/reserved/annotation/foo/bar%20baz")))
        .status,
    ).toBe(204);
    expect(received.get("reservedAnnotation")).toEqual({ value: "foo/bar baz" });
    expect((await router.handle(new Request("http://localhost/reserved/template"))).status).toBe(
      404,
    );
    expect(
      (await router.handle(new Request("http://localhost/reserved/template/foo/"))).status,
    ).toBe(404);

    expect((await router.handle(new Request("http://localhost/trail/"))).status).toBe(204);
    expect((await router.handle(new Request("http://localhost/trail"))).status).toBe(404);

    expect(
      (await router.handle(new Request("http://localhost/query/item?tags=one&tags=two"))).status,
    ).toBe(204);
    expect(received.get("query")).toEqual({ id: "item", tags: ["one", "two"] });

    expect(
      (await router.handle(new Request("http://localhost/query-record?param=a,1,b,2"))).status,
    ).toBe(204);
    expect(received.get("queryRecord")).toEqual({ param: { a: 1, b: 2 } });
    expect(
      (await router.handle(new Request("http://localhost/query-record?param=a%2Cb,1,first+name,2")))
        .status,
    ).toBe(204);
    expect(received.get("queryRecord")).toEqual({ param: { "a,b": 1, "first name": 2 } });
    expect((await router.handle(new Request("http://localhost/query-record"))).status).toBe(204);
    expect(received.get("queryRecord")).toEqual({ param: {} });
    expect(
      (await router.handle(new Request("http://localhost/query-record?other=value"))).status,
    ).toBe(204);
    expect(received.get("queryRecord")).toEqual({ param: {} });
    expect((await router.handle(new Request("http://localhost/query-record?param="))).status).toBe(
      400,
    );
    expect(
      (await router.handle(new Request("http://localhost/query-record?param=a,1,b"))).status,
    ).toBe(400);
    expect(
      (await router.handle(new Request("http://localhost/query-record?param=a,1&param=b,2")))
        .status,
    ).toBe(400);
    expect(
      (await router.handle(new Request("http://localhost/query-record?param=a,1,%61,2"))).status,
    ).toBe(400);

    expect(
      (
        await router.handle(
          new Request("http://localhost/query-record-explode?a=1&b%26c=2&t%61g=keep"),
        )
      ).status,
    ).toBe(204);
    expect(received.get("queryRecordExplode")).toEqual({
      param: { a: 1, "b&c": 2 },
      tag: "keep",
    });
    expect(
      (await router.handle(new Request("http://localhost/query-record-explode?param=3"))).status,
    ).toBe(204);
    expect(received.get("queryRecordExplode")).toEqual({ param: { param: 3 }, tag: undefined });
    expect(
      (await router.handle(new Request("http://localhost/query-record-explode?tag=keep"))).status,
    ).toBe(204);
    expect(received.get("queryRecordExplode")).toEqual({ param: {}, tag: "keep" });
    expect((await router.handle(new Request("http://localhost/query-record-explode"))).status).toBe(
      204,
    );
    expect(received.get("queryRecordExplode")).toEqual({ param: {}, tag: undefined });
    expect(
      (await router.handle(new Request("http://localhost/query-record-explode?a=1&%61=2"))).status,
    ).toBe(400);
    expect(
      (await router.handle(new Request("http://localhost/query-record-explode?%E0%A4%A=1"))).status,
    ).toBe(400);

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

    expect(
      (await router.handle(new Request("http://localhost/slash-array/array/a,b%2Cc"))).status,
    ).toBe(204);
    expect(received.get("slashArray")).toEqual({ param: ["a", "b,c"] });
    expect((await router.handle(new Request("http://localhost/slash-array/array"))).status).toBe(
      404,
    );

    expect(
      (await router.handle(new Request("http://localhost/slash-record/record/a,1,b,2"))).status,
    ).toBe(204);
    expect(received.get("slashRecord")).toEqual({ param: { a: 1, b: 2 } });
    expect(
      (await router.handle(new Request("http://localhost/slash-record/record/a%2Cb,1"))).status,
    ).toBe(204);
    expect(received.get("slashRecord")).toEqual({ param: { "a,b": 1 } });
    expect(
      (await router.handle(new Request("http://localhost/slash-record/record/a,1,b"))).status,
    ).toBe(400);
    expect(
      (await router.handle(new Request("http://localhost/slash-record/record/a,1,%61,2"))).status,
    ).toBe(400);
    expect((await router.handle(new Request("http://localhost/slash-record/record"))).status).toBe(
      404,
    );

    expect(
      (await router.handle(new Request("http://localhost/slash-array-explode/array/a/b%2Fc")))
        .status,
    ).toBe(204);
    expect(received.get("slashArrayExplode")).toEqual({ param: ["a", "b/c"] });
    expect(
      (await router.handle(new Request("http://localhost/slash-array-explode/array"))).status,
    ).toBe(404);
    expect(
      (await router.handle(new Request("http://localhost/slash-array-explode/array/a/"))).status,
    ).toBe(404);

    expect(
      (await router.handle(new Request("http://localhost/slash-record-explode/record/a=1/b=2")))
        .status,
    ).toBe(204);
    expect(received.get("slashRecordExplode")).toEqual({ param: { a: 1, b: 2 } });
    expect(
      (await router.handle(new Request("http://localhost/slash-record-explode/record/a%2Fb=1")))
        .status,
    ).toBe(204);
    expect(received.get("slashRecordExplode")).toEqual({ param: { "a/b": 1 } });
    expect(
      (await router.handle(new Request("http://localhost/slash-record-explode/record/a=1/b")))
        .status,
    ).toBe(400);
    expect(
      (await router.handle(new Request("http://localhost/slash-record-explode/record/a=1/%61=2")))
        .status,
    ).toBe(400);
    expect(
      (await router.handle(new Request("http://localhost/slash-record-explode/record"))).status,
    ).toBe(404);
    expect(
      (await router.handle(new Request("http://localhost/slash-record-explode/record/a=1/")))
        .status,
    ).toBe(404);

    expect(
      (await router.handle(new Request("http://localhost/simple-explode/itema%2Fb"))).status,
    ).toBe(204);
    expect(received.get("simpleExplode")).toEqual({ name: "a/b" });
    expect((await router.handle(new Request("http://localhost/simple-explode/item"))).status).toBe(
      204,
    );
    expect(received.get("simpleExplode")).toEqual({ name: "" });

    expect(
      (await router.handle(new Request("http://localhost/simple-array/arraya,b%2Cc"))).status,
    ).toBe(204);
    expect(received.get("simpleArray")).toEqual({ param: ["a", "b,c"] });

    expect(
      (await router.handle(new Request("http://localhost/simple-record/recorda,1,b,2"))).status,
    ).toBe(204);
    expect(received.get("simpleRecord")).toEqual({ param: { a: 1, b: 2 } });
    expect(
      (await router.handle(new Request("http://localhost/simple-record/recorda%2Cb,1"))).status,
    ).toBe(204);
    expect(received.get("simpleRecord")).toEqual({ param: { "a,b": 1 } });
    expect((await router.handle(new Request("http://localhost/simple-record/record"))).status).toBe(
      204,
    );
    expect(received.get("simpleRecord")).toEqual({ param: {} });
    expect(
      (await router.handle(new Request("http://localhost/simple-record/recorda,1,b"))).status,
    ).toBe(400);
    expect(
      (await router.handle(new Request("http://localhost/simple-record/recorda,1,%61,2"))).status,
    ).toBe(400);

    expect(
      (await router.handle(new Request("http://localhost/simple-record-explode/recorda=1,b=2")))
        .status,
    ).toBe(204);
    expect(received.get("simpleRecordExplode")).toEqual({ param: { a: 1, b: 2 } });
    expect(
      (await router.handle(new Request("http://localhost/simple-record-explode/recorda%2Cb%3Dc=1")))
        .status,
    ).toBe(204);
    expect(received.get("simpleRecordExplode")).toEqual({ param: { "a,b=c": 1 } });
    expect(
      (
        await router.handle(
          new Request("http://localhost/simple-record-explode/record__proto__=1,constructor=2"),
        )
      ).status,
    ).toBe(204);
    const prototypeKeys = received.get("simpleRecordExplode") as {
      param: Record<string, number>;
    };
    expect(prototypeKeys.param["__proto__"]).toBe(1);
    expect(prototypeKeys.param.constructor).toBe(2);
    expect(Object.getPrototypeOf(prototypeKeys.param)).toBe(Object.prototype);
    expect(
      (await router.handle(new Request("http://localhost/simple-record-explode/recorda=1,b")))
        .status,
    ).toBe(400);
    expect(
      (await router.handle(new Request("http://localhost/simple-record-explode/recorda=1,%61=2")))
        .status,
    ).toBe(400);

    expect((await router.handle(new Request("http://localhost/label/item.a%2Fb"))).status).toBe(
      204,
    );
    expect(received.get("label")).toEqual({ name: "a/b" });
    expect((await router.handle(new Request("http://localhost/label/item"))).status).toBe(404);

    expect(
      (await router.handle(new Request("http://localhost/label-explode/item.value"))).status,
    ).toBe(204);
    expect(received.get("labelExplode")).toEqual({ name: "value" });
    expect((await router.handle(new Request("http://localhost/label-explode/item."))).status).toBe(
      204,
    );
    expect(received.get("labelExplode")).toEqual({ name: "" });

    expect(
      (await router.handle(new Request("http://localhost/label-array/array.a,b%2Cc"))).status,
    ).toBe(204);
    expect(received.get("labelArray")).toEqual({ param: ["a", "b,c"] });
    expect((await router.handle(new Request("http://localhost/label-array/array"))).status).toBe(
      404,
    );

    expect(
      (await router.handle(new Request("http://localhost/label-array-explode/array.a.b%2Ec")))
        .status,
    ).toBe(204);
    expect(received.get("labelArrayExplode")).toEqual({ param: ["a", "b.c"] });
    expect(
      (await router.handle(new Request("http://localhost/label-array-explode/array"))).status,
    ).toBe(404);

    expect(
      (await router.handle(new Request("http://localhost/label-record/record.a,1,b,2"))).status,
    ).toBe(204);
    expect(received.get("labelRecord")).toEqual({ param: { a: 1, b: 2 } });
    expect(
      (await router.handle(new Request("http://localhost/label-record/record.a%2Fb,1"))).status,
    ).toBe(204);
    expect(received.get("labelRecord")).toEqual({ param: { "a/b": 1 } });
    expect(
      (await router.handle(new Request("http://localhost/label-record/record.a,1,b"))).status,
    ).toBe(400);
    expect(
      (await router.handle(new Request("http://localhost/label-record/record.a,1,%61,2"))).status,
    ).toBe(400);
    expect((await router.handle(new Request("http://localhost/label-record/record."))).status).toBe(
      400,
    );
    expect((await router.handle(new Request("http://localhost/label-record/record"))).status).toBe(
      204,
    );
    expect(received.get("labelRecord")).toEqual({ param: {} });

    expect(
      (await router.handle(new Request("http://localhost/label-record-explode/record.a=1.b=2")))
        .status,
    ).toBe(204);
    expect(received.get("labelRecordExplode")).toEqual({ param: { a: 1, b: 2 } });
    expect(
      (await router.handle(new Request("http://localhost/label-record-explode/record.a%2Eb%3Dc=1")))
        .status,
    ).toBe(204);
    expect(received.get("labelRecordExplode")).toEqual({ param: { "a.b=c": 1 } });
    expect(
      (await router.handle(new Request("http://localhost/label-record-explode/record.a=1.b")))
        .status,
    ).toBe(400);
    expect(
      (await router.handle(new Request("http://localhost/label-record-explode/record.%E0%A4%A=1")))
        .status,
    ).toBe(400);
    expect(
      (await router.handle(new Request("http://localhost/label-record-explode/record.a=1.%61=2")))
        .status,
    ).toBe(400);
    expect(
      (await router.handle(new Request("http://localhost/label-record-explode/record."))).status,
    ).toBe(400);
    expect(
      (await router.handle(new Request("http://localhost/label-record-explode/record"))).status,
    ).toBe(204);
    expect(received.get("labelRecordExplode")).toEqual({ param: {} });

    expect(
      (await router.handle(new Request("http://localhost/label-record-segment/.a,1"))).status,
    ).toBe(204);
    expect(received.get("labelRecordSegment")).toEqual({ param: { a: 1 } });
    expect(
      (await router.handle(new Request("http://localhost/label-record-segment/"))).status,
    ).toBe(204);
    expect(received.get("labelRecordSegment")).toEqual({ param: {} });
    expect((await router.handle(new Request("http://localhost/label-record-segment"))).status).toBe(
      404,
    );

    expect(
      (await router.handle(new Request("http://localhost/matrix/item;name=a%2Fb"))).status,
    ).toBe(204);
    expect(received.get("matrix")).toEqual({ name: "a/b" });
    expect((await router.handle(new Request("http://localhost/matrix/item;a%2Fb"))).status).toBe(
      404,
    );

    expect(
      (await router.handle(new Request("http://localhost/matrix-explode/item;name=value"))).status,
    ).toBe(204);
    expect(received.get("matrixExplode")).toEqual({ name: "value" });
    expect(
      (await router.handle(new Request("http://localhost/matrix-explode/item;name="))).status,
    ).toBe(204);
    expect(received.get("matrixExplode")).toEqual({ name: "" });

    expect(
      (await router.handle(new Request("http://localhost/matrix-array/array;param=a,b%2Cc")))
        .status,
    ).toBe(204);
    expect(received.get("matrixArray")).toEqual({ param: ["a", "b,c"] });
    expect((await router.handle(new Request("http://localhost/matrix-array/array"))).status).toBe(
      404,
    );

    expect(
      (
        await router.handle(
          new Request("http://localhost/matrix-array-explode/array;param=a;param=b%3Bparam%3Dc"),
        )
      ).status,
    ).toBe(204);
    expect(received.get("matrixArrayExplode")).toEqual({ param: ["a", "b;param=c"] });
    expect(
      (await router.handle(new Request("http://localhost/matrix-array-explode/array"))).status,
    ).toBe(404);

    expect(
      (await router.handle(new Request("http://localhost/matrix-record/record;param=a,1,b,2")))
        .status,
    ).toBe(204);
    expect(received.get("matrixRecord")).toEqual({ param: { a: 1, b: 2 } });
    expect(
      (await router.handle(new Request("http://localhost/matrix-record/record;param=a%2Cb,1")))
        .status,
    ).toBe(204);
    expect(received.get("matrixRecord")).toEqual({ param: { "a,b": 1 } });
    expect(
      (await router.handle(new Request("http://localhost/matrix-record/record;param=a,1,b")))
        .status,
    ).toBe(400);
    expect(
      (await router.handle(new Request("http://localhost/matrix-record/record;param=%E0%A4%A,1")))
        .status,
    ).toBe(400);
    expect(
      (await router.handle(new Request("http://localhost/matrix-record/record;param=a,1,%61,2")))
        .status,
    ).toBe(400);
    expect(
      (await router.handle(new Request("http://localhost/matrix-record/record;param="))).status,
    ).toBe(400);
    expect(
      (await router.handle(new Request("http://localhost/matrix-record/record;param"))).status,
    ).toBe(404);
    expect((await router.handle(new Request("http://localhost/matrix-record/record"))).status).toBe(
      204,
    );
    expect(received.get("matrixRecord")).toEqual({ param: {} });

    expect(
      (await router.handle(new Request("http://localhost/matrix-record-explode/record;a=1;b=2")))
        .status,
    ).toBe(204);
    expect(received.get("matrixRecordExplode")).toEqual({ param: { a: 1, b: 2 } });
    expect(
      (
        await router.handle(
          new Request("http://localhost/matrix-record-explode/record;a%3Bb%3Dc=1"),
        )
      ).status,
    ).toBe(204);
    expect(received.get("matrixRecordExplode")).toEqual({ param: { "a;b=c": 1 } });
    expect(
      (await router.handle(new Request("http://localhost/matrix-record-explode/record;a=1;b")))
        .status,
    ).toBe(400);
    expect(
      (await router.handle(new Request("http://localhost/matrix-record-explode/record;%E0%A4%A=1")))
        .status,
    ).toBe(400);
    expect(
      (await router.handle(new Request("http://localhost/matrix-record-explode/record;a=1;%61=2")))
        .status,
    ).toBe(400);
    expect(
      (await router.handle(new Request("http://localhost/matrix-record-explode/record;"))).status,
    ).toBe(400);
    expect(
      (await router.handle(new Request("http://localhost/matrix-record-explode/record"))).status,
    ).toBe(204);
    expect(received.get("matrixRecordExplode")).toEqual({ param: {} });
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
    expect(diagnostics).toContain(
      'exploded simple path variable "x" must have a scalar, scalar-array, or scalar-record wire shape',
    );
    expect(diagnostics).toContain('modifier ":2"');
    expect(diagnostics).toContain("a reserved expansion must occupy a complete path segment");
    expect(diagnostics).toContain("path material appears after a reserved expansion");
    expect(diagnostics).toContain("appears more than once");
    expect(diagnostics).toContain(
      'path variables separated only by commas require scalar variables, but "x" has a collection shape',
    );
    expect(diagnostics).toContain(
      'path variables separated only by commas require scalar variables, but "left" has a collection shape',
    );
    expect(diagnostics).toContain("nested '{'");
    expect(diagnostics).toContain("path material appears after a query expansion");
    expect(diagnostics).toContain('label-expanded path variable "x" must be required');
    expect(diagnostics).toContain(
      'label-expanded path variable "x" must have a scalar, scalar-array, or scalar-record wire shape',
    );
    expect(diagnostics).toContain(
      "label record expansions must not share a path segment with another path variable",
    );
    expect(diagnostics).toContain("label expansions must contain exactly one path variable");
    expect(diagnostics).toContain('matrix-expanded path variable "x" must be required');
    expect(diagnostics).toContain(
      'matrix-expanded path variable "x" must have a scalar, scalar-array, or scalar-record wire shape',
    );
    expect(diagnostics).toContain("matrix expansions must contain exactly one path variable");
    expect(diagnostics).toContain("path material appears after an exploded slash expansion");
    expect(diagnostics).toContain('slash-expanded scalar-array path variable "x" must be required');
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
    const { lowerUriTemplate, lowerUriTemplateText } = await import("../dist/uri-template.js");
    const path = new Set(["x"]);
    const query = new Set<string>();

    const operation = (uriTemplate: string) =>
      ({
        uriTemplate,
        parameters: {
          parameters: [
            {
              type: "path",
              name: "x",
              style: "path",
              allowReserved: false,
              param: { optional: false, type: { kind: "String", value: "" } },
            },
          ],
        },
      }) as never;
    const simpleStyle = lowerUriTemplate(operation("/simple/{x}"));
    expect(simpleStyle.ok && simpleStyle.value.slashExpandedPathNames).toEqual([]);
    expect(simpleStyle.ok && simpleStyle.value.labelExpandedPathNames).toEqual([]);
    expect(simpleStyle.ok && simpleStyle.value.matrixExpandedPathNames).toEqual([]);
    expect(simpleStyle.ok && simpleStyle.value.reservedExpandedPathNames).toEqual([]);
    const slashStyle = lowerUriTemplate(operation("/slash{/x}"));
    expect(slashStyle.ok && slashStyle.value.slashExpandedPathNames).toEqual(["x"]);
    expect(slashStyle.ok && slashStyle.value.labelExpandedPathNames).toEqual([]);
    expect(slashStyle.ok && slashStyle.value.matrixExpandedPathNames).toEqual([]);
    const labelStyle = lowerUriTemplate(operation("/label{.x}"));
    expect(labelStyle.ok && labelStyle.value.slashExpandedPathNames).toEqual([]);
    expect(labelStyle.ok && labelStyle.value.labelExpandedPathNames).toEqual(["x"]);
    expect(labelStyle.ok && labelStyle.value.matrixExpandedPathNames).toEqual([]);
    const matrixStyle = lowerUriTemplate(operation("/matrix{;x}"));
    expect(matrixStyle.ok && matrixStyle.value.slashExpandedPathNames).toEqual([]);
    expect(matrixStyle.ok && matrixStyle.value.labelExpandedPathNames).toEqual([]);
    expect(matrixStyle.ok && matrixStyle.value.matrixExpandedPathNames).toEqual(["x"]);
    const reservedStyle = lowerUriTemplate(operation("/reserved/{+x}"));
    expect(reservedStyle.ok && reservedStyle.value.slashExpandedPathNames).toEqual([]);
    expect(reservedStyle.ok && reservedStyle.value.labelExpandedPathNames).toEqual([]);
    expect(reservedStyle.ok && reservedStyle.value.matrixExpandedPathNames).toEqual([]);
    expect(reservedStyle.ok && reservedStyle.value.reservedExpandedPathNames).toEqual(["x"]);

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
    expect(lowerUriTemplateText("/simple/item{x*}", path, query)).toEqual({
      ok: true,
      value: {
        path: "/simple/item{x*}",
        routePatterns: [
          {
            segments: [
              [{ kind: "literal", value: "simple" }],
              [
                { kind: "literal", value: "item" },
                { kind: "parameter", name: "x" },
              ],
            ],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(lowerUriTemplateText("/simple/{x*}", path, query, new Set())).toEqual({
      ok: false,
      reason:
        'exploded simple path variable "x" must have a scalar, scalar-array, or scalar-record wire shape',
    });
    expect(
      lowerUriTemplateText("/simple/array{x*}", path, query, new Set(), new Set(), path),
    ).toEqual({
      ok: true,
      value: {
        path: "/simple/array{x*}",
        routePatterns: [
          {
            segments: [
              [{ kind: "literal", value: "simple" }],
              [
                { kind: "literal", value: "array" },
                { kind: "parameter", name: "x" },
              ],
            ],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(
      lowerUriTemplateText(
        "/simple/record{x*}",
        path,
        query,
        new Set(),
        new Set(),
        new Set(),
        path,
      ),
    ).toEqual({
      ok: true,
      value: {
        path: "/simple/record{x*}",
        routePatterns: [
          {
            segments: [
              [{ kind: "literal", value: "simple" }],
              [
                { kind: "literal", value: "record" },
                { kind: "parameter", name: "x" },
              ],
            ],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(lowerUriTemplateText("/simple/{x*}", path, query, path, new Set(["x"]))).toEqual({
      ok: false,
      reason: 'exploded simple path variable "x" must be required',
    });
    expect(
      lowerUriTemplateText("/simple/{x,y*}", new Set(["x", "y"]), query, new Set(["x", "y"])),
    ).toEqual({
      ok: false,
      reason: "exploded simple expansions must contain exactly one path variable",
    });
    expect(lowerUriTemplateText("/label/item{.x}", path, query)).toEqual({
      ok: true,
      value: {
        path: "/label/item{.x}",
        routePatterns: [
          {
            segments: [
              [{ kind: "literal", value: "label" }],
              [
                { kind: "literal", value: "item." },
                { kind: "parameter", name: "x" },
              ],
            ],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(lowerUriTemplateText("/label/item{.x*}", path, query)).toEqual({
      ok: true,
      value: {
        path: "/label/item{.x*}",
        routePatterns: [
          {
            segments: [
              [{ kind: "literal", value: "label" }],
              [
                { kind: "literal", value: "item." },
                { kind: "parameter", name: "x" },
              ],
            ],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(lowerUriTemplateText("/label/item{.x}", path, query, new Set())).toEqual({
      ok: false,
      reason:
        'label-expanded path variable "x" must have a scalar, scalar-array, or scalar-record wire shape',
    });
    expect(
      lowerUriTemplateText("/label/array{.x}", path, query, new Set(), new Set(), path),
    ).toEqual({
      ok: true,
      value: {
        path: "/label/array{.x}",
        routePatterns: [
          {
            segments: [
              [{ kind: "literal", value: "label" }],
              [
                { kind: "literal", value: "array." },
                { kind: "parameter", name: "x" },
              ],
            ],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(
      lowerUriTemplateText("/label/array{.x*}", path, query, new Set(), new Set(), path),
    ).toEqual({
      ok: true,
      value: {
        path: "/label/array{.x*}",
        routePatterns: [
          {
            segments: [
              [{ kind: "literal", value: "label" }],
              [
                { kind: "literal", value: "array." },
                { kind: "parameter", name: "x" },
              ],
            ],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(
      lowerUriTemplateText("/label/record{.x}", path, query, new Set(), new Set(), new Set(), path),
    ).toEqual({
      ok: true,
      value: {
        path: "/label/record{.x}",
        routePatterns: [
          {
            segments: [
              [{ kind: "literal", value: "label" }],
              [
                { kind: "literal", value: "record." },
                { kind: "parameter", name: "x" },
              ],
            ],
            trailingSlash: false,
          },
          {
            segments: [
              [{ kind: "literal", value: "label" }],
              [{ kind: "literal", value: "record" }],
            ],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(
      lowerUriTemplateText("/label/{.x}", path, query, new Set(), new Set(), new Set(), path),
    ).toEqual({
      ok: true,
      value: {
        path: "/label/{.x}",
        routePatterns: [
          {
            segments: [
              [{ kind: "literal", value: "label" }],
              [
                { kind: "literal", value: "." },
                { kind: "parameter", name: "x" },
              ],
            ],
            trailingSlash: false,
          },
          {
            segments: [[{ kind: "literal", value: "label" }]],
            trailingSlash: true,
          },
        ],
      },
    });
    expect(
      lowerUriTemplateText("/label/{.x}/tail", path, query, new Set(), new Set(), new Set(), path),
    ).toEqual({
      ok: false,
      reason: "an empty label record expansion would produce an unsupported empty path segment",
    });
    expect(
      lowerUriTemplateText(
        "/items{.rec}{/opt}",
        new Set(["rec", "opt"]),
        query,
        new Set(["opt"]),
        new Set(["opt"]),
        new Set(),
        new Set(["rec"]),
      ),
    ).toEqual({
      ok: true,
      value: {
        path: "/items{.rec}{/opt}",
        routePatterns: [
          {
            segments: [
              [
                { kind: "literal", value: "items." },
                { kind: "parameter", name: "rec" },
              ],
            ],
            trailingSlash: false,
          },
          {
            segments: [
              [
                { kind: "literal", value: "items." },
                { kind: "parameter", name: "rec" },
              ],
              [{ kind: "parameter", name: "opt" }],
            ],
            trailingSlash: false,
          },
          {
            segments: [[{ kind: "literal", value: "items" }]],
            trailingSlash: false,
          },
          {
            segments: [[{ kind: "literal", value: "items" }], [{ kind: "parameter", name: "opt" }]],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(
      lowerUriTemplateText(
        "/{.rec}{/opt}",
        new Set(["rec", "opt"]),
        query,
        new Set(["opt"]),
        new Set(["opt"]),
        new Set(),
        new Set(["rec"]),
      ),
    ).toEqual({
      ok: false,
      reason: "an empty label record expansion would produce an unsupported empty path segment",
    });
    expect(
      lowerUriTemplateText(
        "/pairs/{left}:{.right}",
        new Set(["left", "right"]),
        query,
        new Set(["left"]),
        new Set(),
        new Set(),
        new Set(["right"]),
      ),
    ).toEqual({
      ok: false,
      reason: "label record expansions must not share a path segment with another path variable",
    });
    expect(
      lowerUriTemplateText(
        "/label/record{.x*}",
        path,
        query,
        new Set(),
        new Set(),
        new Set(),
        path,
      ),
    ).toEqual({
      ok: true,
      value: {
        path: "/label/record{.x*}",
        routePatterns: [
          {
            segments: [
              [{ kind: "literal", value: "label" }],
              [
                { kind: "literal", value: "record." },
                { kind: "parameter", name: "x" },
              ],
            ],
            trailingSlash: false,
          },
          {
            segments: [
              [{ kind: "literal", value: "label" }],
              [{ kind: "literal", value: "record" }],
            ],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(lowerUriTemplateText("/label/item{.x}", path, query, new Set(), path, path)).toEqual({
      ok: false,
      reason: 'label-expanded path variable "x" must be required',
    });
    expect(lowerUriTemplateText("/label/item{.x}", path, query, path, new Set(["x"]))).toEqual({
      ok: false,
      reason: 'label-expanded path variable "x" must be required',
    });
    expect(
      lowerUriTemplateText("/label/item{.x,y}", new Set(["x", "y"]), query, new Set(["x", "y"])),
    ).toEqual({
      ok: false,
      reason: "label expansions must contain exactly one path variable",
    });
    expect(lowerUriTemplateText("/matrix/item{;x}", path, query)).toEqual({
      ok: true,
      value: {
        path: "/matrix/item{;x}",
        routePatterns: [
          {
            segments: [
              [{ kind: "literal", value: "matrix" }],
              [
                { kind: "literal", value: "item;x=" },
                { kind: "parameter", name: "x" },
              ],
            ],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(lowerUriTemplateText("/matrix/item{;x*}", path, query)).toEqual({
      ok: true,
      value: {
        path: "/matrix/item{;x*}",
        routePatterns: [
          {
            segments: [
              [{ kind: "literal", value: "matrix" }],
              [
                { kind: "literal", value: "item;x=" },
                { kind: "parameter", name: "x" },
              ],
            ],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(lowerUriTemplateText("/matrix/item{;%78}", path, query)).toEqual({
      ok: false,
      reason: "percent-encoded matrix variable names are not supported",
    });
    expect(lowerUriTemplateText("/matrix/item{;x}", path, query, new Set())).toEqual({
      ok: false,
      reason:
        'matrix-expanded path variable "x" must have a scalar, scalar-array, or scalar-record wire shape',
    });
    expect(
      lowerUriTemplateText("/matrix/array{;x}", path, query, new Set(), new Set(), path),
    ).toEqual({
      ok: true,
      value: {
        path: "/matrix/array{;x}",
        routePatterns: [
          {
            segments: [
              [{ kind: "literal", value: "matrix" }],
              [
                { kind: "literal", value: "array;x=" },
                { kind: "parameter", name: "x" },
              ],
            ],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(
      lowerUriTemplateText("/matrix/array{;x*}", path, query, new Set(), new Set(), path),
    ).toEqual({
      ok: true,
      value: {
        path: "/matrix/array{;x*}",
        routePatterns: [
          {
            segments: [
              [{ kind: "literal", value: "matrix" }],
              [
                { kind: "literal", value: "array;x=" },
                { kind: "parameter", name: "x" },
              ],
            ],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(
      lowerUriTemplateText(
        "/matrix/record{;x}",
        path,
        query,
        new Set(),
        new Set(),
        new Set(),
        path,
      ),
    ).toEqual({
      ok: true,
      value: {
        path: "/matrix/record{;x}",
        routePatterns: [
          {
            segments: [
              [{ kind: "literal", value: "matrix" }],
              [
                { kind: "literal", value: "record;x=" },
                { kind: "parameter", name: "x" },
              ],
            ],
            trailingSlash: false,
          },
          {
            segments: [
              [{ kind: "literal", value: "matrix" }],
              [{ kind: "literal", value: "record" }],
            ],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(
      lowerUriTemplateText(
        "/matrix/record{;x*}",
        path,
        query,
        new Set(),
        new Set(),
        new Set(),
        path,
      ),
    ).toEqual({
      ok: true,
      value: {
        path: "/matrix/record{;x*}",
        routePatterns: [
          {
            segments: [
              [{ kind: "literal", value: "matrix" }],
              [
                { kind: "literal", value: "record;" },
                { kind: "parameter", name: "x" },
              ],
            ],
            trailingSlash: false,
          },
          {
            segments: [
              [{ kind: "literal", value: "matrix" }],
              [{ kind: "literal", value: "record" }],
            ],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(lowerUriTemplateText("/matrix/item{;x}", path, query, new Set(), path, path)).toEqual({
      ok: false,
      reason: 'matrix-expanded path variable "x" must be required',
    });
    expect(lowerUriTemplateText("/matrix/item{;x}", path, query, path, new Set(["x"]))).toEqual({
      ok: false,
      reason: 'matrix-expanded path variable "x" must be required',
    });
    expect(
      lowerUriTemplateText("/matrix/item{;x,y}", new Set(["x", "y"]), query, new Set(["x", "y"])),
    ).toEqual({
      ok: false,
      reason: "matrix expansions must contain exactly one path variable",
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
      reason:
        'slash-expanded path variable "x" must have a scalar, scalar-array, or scalar-record wire shape',
    });
    expect(
      lowerUriTemplateText("/slash-array/array{/x}", path, query, new Set(), new Set(), path),
    ).toEqual({
      ok: true,
      value: {
        path: "/slash-array/array{/x}",
        routePatterns: [
          {
            segments: [
              [{ kind: "literal", value: "slash-array" }],
              [{ kind: "literal", value: "array" }],
              [{ kind: "parameter", name: "x" }],
            ],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(
      lowerUriTemplateText(
        "/slash-record/record{/x*}/tail",
        path,
        query,
        new Set(),
        new Set(),
        new Set(),
        path,
      ),
    ).toEqual({
      ok: false,
      reason: "path material appears after an exploded slash expansion",
    });
    expect(
      lowerUriTemplateText(
        "/slash-record/record{/x}",
        path,
        query,
        new Set(),
        new Set(),
        new Set(),
        path,
      ),
    ).toEqual({
      ok: true,
      value: {
        path: "/slash-record/record{/x}",
        routePatterns: [
          {
            segments: [
              [{ kind: "literal", value: "slash-record" }],
              [{ kind: "literal", value: "record" }],
              [{ kind: "parameter", name: "x" }],
            ],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(
      lowerUriTemplateText(
        "/slash-record/record{/x*}",
        path,
        query,
        new Set(),
        new Set(),
        new Set(),
        path,
      ),
    ).toEqual({
      ok: true,
      value: {
        path: "/slash-record/record{/x*}",
        routePatterns: [
          {
            segments: [
              [{ kind: "literal", value: "slash-record" }],
              [{ kind: "literal", value: "record" }],
              [{ kind: "rest", name: "x" }],
            ],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(
      lowerUriTemplateText(
        "/slash-record/record{/x}",
        path,
        query,
        new Set(),
        path,
        new Set(),
        path,
      ),
    ).toEqual({
      ok: false,
      reason: 'slash-expanded scalar-record path variable "x" must be required',
    });
    expect(
      lowerUriTemplateText("/slash-array/array{/x*}", path, query, new Set(), new Set(), path),
    ).toEqual({
      ok: true,
      value: {
        path: "/slash-array/array{/x*}",
        routePatterns: [
          {
            segments: [
              [{ kind: "literal", value: "slash-array" }],
              [{ kind: "literal", value: "array" }],
              [{ kind: "rest", name: "x" }],
            ],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(
      lowerUriTemplateText("/slash-array/array{/x*}/tail", path, query, new Set(), new Set(), path),
    ).toEqual({
      ok: false,
      reason: "path material appears after an exploded slash expansion",
    });
    expect(
      lowerUriTemplateText("/slash-array/array{/x}", path, query, new Set(), path, path),
    ).toEqual({
      ok: false,
      reason: 'slash-expanded scalar-array path variable "x" must be required',
    });
    expect(lowerUriTemplateText("/reserved/{+x}", path, query)).toEqual({
      ok: true,
      value: {
        path: "/reserved/{+x}",
        routePatterns: [
          {
            segments: [[{ kind: "literal", value: "reserved" }], [{ kind: "rest", name: "x" }]],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(lowerUriTemplateText("/reserved/{+x*}", path, query)).toEqual({
      ok: true,
      value: {
        path: "/reserved/{+x*}",
        routePatterns: [
          {
            segments: [[{ kind: "literal", value: "reserved" }], [{ kind: "rest", name: "x" }]],
            trailingSlash: false,
          },
        ],
      },
    });
    expect(lowerUriTemplateText("/reserved/pre{+x}", path, query)).toEqual({
      ok: false,
      reason: "a reserved expansion must occupy a complete path segment",
    });
    expect(lowerUriTemplateText("/reserved/{+x}/tail", path, query)).toEqual({
      ok: false,
      reason: "path material appears after a reserved expansion",
    });
    expect(lowerUriTemplateText("/reserved/{+x}{?q}", path, new Set(["q"]))).toEqual({
      ok: false,
      reason: "a query expansion cannot follow a reserved path expansion",
    });
    expect(
      lowerUriTemplateText("/reserved/{+x,y}", new Set(["x", "y"]), query, new Set(["x", "y"])),
    ).toEqual({
      ok: false,
      reason: "reserved expansions must contain exactly one path variable",
    });
    expect(lowerUriTemplateText("/reserved/{+x}", path, query, new Set())).toEqual({
      ok: false,
      reason: 'reserved path variable "x" must have a scalar wire shape',
    });
    expect(lowerUriTemplateText("/reserved/{+x}", path, query, path, path)).toEqual({
      ok: false,
      reason: 'reserved path variable "x" must be required',
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
