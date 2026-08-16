import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildEmitter, cleanupFixtures, compileFixture } from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const selfRecursiveUnionSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "RecursiveUnion" })
namespace RecursiveUnion;

union JsonValue {
  text: string,
  list: JsonValue[],
}

@route("/value")
@post
op create(
  @header contentType: "application/json",
  @body value: JsonValue,
): void;
`;

const mutuallyRecursiveUnionSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "MutualUnion" })
namespace MutualUnion;

union LeftValue {
  text: string,
  rights: RightValue[],
}

union RightValue {
  number: int32,
  lefts: LeftValue[],
}

@route("/value")
@post
op create(
  @header contentType: "application/json",
  @body value: LeftValue,
): void;
`;

const selfRecursiveGenericSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "RecursiveGeneric" })
namespace RecursiveGeneric;

@maxLength(2)
scalar Short extends string;

model Node<T> {
  value: T;
  next?: Node<T>;
}

model Payload {
  strings: Node<string>;
  numbers: Node<int32>;
  short: Node<Short>;
  plain: Node<string>;
}

@route("/nodes")
@post
op create(@body body: Payload): void;
`;

const mutuallyRecursiveGenericSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "MutualGeneric" })
namespace MutualGeneric;

model Left<T> {
  value: T;
  right?: Right<T>;
}

model Right<T> {
  value: T;
  left?: Left<T>;
}

model Payload {
  root: Left<string>;
}

@route("/nodes")
@post
op create(@body body: Payload): void;
`;

const crossGroupRecursiveGenericSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "CrossGroupGeneric" })
namespace CrossGroupGeneric;

model Node<T> {
  value: T;
  next?: Node<T>;
}

@route("/strings")
interface Strings {
  @post create(@body body: Node<string>): void;
}

@route("/numbers")
interface Numbers {
  @post create(@body body: Node<int32>): void;
}
`;

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("recursive named types", () => {
  test("emits and executes a self-recursive named union decoder", async () => {
    const result = compileFixture("recursive-union", selfRecursiveUnionSpec);
    const models = result.readFile("recursive-union", "models.ts");
    const operations = result.readFile("recursive-union", "server-operations.ts");

    expect(models).toContain("export type JsonValue = string | JsonValue[];");
    expect(operations).toContain('import type { JsonValue } from "./models.js";');
    expect(operations.match(/const _lazy[^:]+: Decoder<JsonValue>/g)).toHaveLength(1);
    result.typecheck("recursive-union");

    const { createRecursiveUnionServerRouter } = await import(
      `${result.outputDir}/recursive-union/server-router.ts`
    );
    let received: unknown;
    const router = createRecursiveUnionServerRouter({
      create(input: unknown) {
        received = input;
      },
    });
    const nested = ["first", ["second"]];

    const response = await router.handle(jsonRequest("/value", nested));

    expect(response.status).toBe(204);
    expect(received).toEqual({ contentType: "application/json", body: nested });

    const invalid = await router.handle(jsonRequest("/value", ["first", [{}]]));
    expect(invalid.status).toBe(400);
  });

  test("emits finite mutually recursive union aliases and decoders", () => {
    const result = compileFixture("mutual-union", mutuallyRecursiveUnionSpec);
    const models = result.readFile("mutual-union", "models.ts");
    const operations = result.readFile("mutual-union", "server-operations.ts");

    expect(models).toContain("export type LeftValue = string | RightValue[];");
    expect(models).toContain("export type RightValue = number | LeftValue[];");
    expect(operations).toContain("Decoder<LeftValue>");
    expect(operations).toContain("Decoders.union<RightValue>");
    result.typecheck("mutual-union");
  });

  test("keeps recursive generic instances and validations independent", async () => {
    const result = compileFixture("recursive-generic", selfRecursiveGenericSpec);
    const models = result.readFile("recursive-generic", "models.ts");
    const operations = result.readFile("recursive-generic", "server-operations.ts");

    expect(models).toContain("next?: Node<T>;");
    expect(operations).toContain("Decoder<Node<string>>");
    expect(operations).toContain("Decoder<Node<number>>");
    // Node<string> is shared by two fields, while Node<Short> has the same
    // rendered TypeScript type but a distinct validation-aware decoder.
    expect(operations.match(/const _lazy[^:]+: Decoder<Node<string>>/g)).toHaveLength(2);
    result.typecheck("recursive-generic");

    const { createRecursiveGenericServerRouter } = await import(
      `${result.outputDir}/recursive-generic/server-router.ts`
    );
    let received: unknown;
    const router = createRecursiveGenericServerRouter({
      create(input: unknown) {
        received = input;
      },
    });
    const valid = {
      strings: { value: "root", next: { value: "leaf" } },
      numbers: { value: 1, next: { value: 2 } },
      short: { value: "a", next: { value: "ok" } },
      plain: { value: "root", next: { value: "a much longer value" } },
    };

    const response = await router.handle(jsonRequest("/nodes", valid));

    expect(response.status).toBe(204);
    expect(received).toEqual(valid);

    const invalidNumber = await router.handle(
      jsonRequest("/nodes", {
        ...valid,
        numbers: { value: 1, next: { value: "not-an-integer" } },
      }),
    );
    expect(invalidNumber.status).toBe(400);

    const invalidShort = await router.handle(
      jsonRequest("/nodes", {
        ...valid,
        short: { value: "a", next: { value: "too long" } },
      }),
    );
    expect(invalidShort.status).toBe(400);
  });

  test("preserves type arguments through mutually recursive generic declarations", () => {
    const result = compileFixture("mutual-generic", mutuallyRecursiveGenericSpec);
    const models = result.readFile("mutual-generic", "models.ts");

    expect(models).toContain("right?: Right<T>;");
    expect(models).toContain("left?: Left<T>;");
    result.typecheck("mutual-generic");
  });

  test("uses module-unique lazy names for same-named operations in different groups", () => {
    const result = compileFixture("cross-group-generic", crossGroupRecursiveGenericSpec);
    const operations = result.readFile("cross-group-generic", "server-operations.ts");
    const names = [
      ...operations.matchAll(/const (_lazy[^:]+): Decoder<Node<(?:string|number)>>/g),
    ].map((match) => match[1]);

    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    result.typecheck("cross-group-generic");
  });
});
