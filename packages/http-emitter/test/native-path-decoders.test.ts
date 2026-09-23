import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { decodePathInput } from "../../http-server/src/index.js";
import { buildEmitter, cleanupFixtures, compileFixture } from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter, 120_000);

test("native string captures preserve validation, names and single property reads", async () => {
  const result = compileFixture(
    "native-string-path",
    `
    import "@typespec/http";
    using TypeSpec.Http;
    @service namespace PathApi;
    @minLength(2) @maxLength(6) scalar Name extends string;
    interface Items {
      @get @route("/named/{wire}")
      named(@path("wire") @maxLength(4) local: Name): void;
      @get @route("/optional{/name}")
      optional(@path name?: Name): void;
      @get @route("/key/{value}")
      key(@path("value") __proto__: Name): void;
      @get @route("/wire/{__proto__}")
      wireKey(@path("__proto__") value: Name): void;
      @get @route("/pattern/{name}")
      pattern(@path @pattern("^[A-Z]", "Capital required.") name: Name): void;
      @get @route("/number/{id}")
      number(@path id: int32): void;
      @get @route("/pair/{first}/{second}")
      pair(@path first: Name, @path second: Name): void;
    }
  `,
  );
  result.typecheck("path-api");
  const source = result.readFile("path-api", "server-operations.ts");
  expect(source).toContain('const value: string | undefined = pathParams["wire"]');
  expect(source).toContain('const value: string | undefined = pathParams["value"]');
  appendFileSync(`${result.outputDir}/path-api/server-operations.ts`, "\nexport { ItemsInput };\n");
  const { ItemsOperations, ItemsInput } = await import(
    `${result.outputDir}/path-api/server-operations.ts`
  );

  for (const [operation, wireName] of [
    ["named", "wire"],
    ["optional", "name"],
    ["key", "value"],
    ["wireKey", "__proto__"],
    ["pattern", "name"],
    ["number", "id"],
  ]) {
    for (const value of [
      undefined,
      null,
      "",
      "a",
      "Ab",
      "1234",
      "12345",
      "abcdefg",
      "%FF",
      "é",
      1,
    ]) {
      const run = (decode: (params: Readonly<Record<string, string>>) => unknown) => {
        let reads = 0;
        const params = Object.defineProperty(Object.create(null), wireName!, {
          get() {
            reads++;
            return value;
          },
        });
        return { result: decode(params), reads: () => reads };
      };
      const expected = run((params) =>
        decodePathInput(ItemsInput[operation!].decode, params, true),
      );
      const actual = run(ItemsOperations[operation!].decodeNativePathInput);
      expect(actual.result).toEqual(expected.result);
      expect(actual.reads()).toBe(expected.reads());
      expect(actual.reads()).toBe(1);
    }
  }
  const key = ItemsOperations.key.decodeNativePathInput({ value: "Ab" }).right;
  expect(Object.hasOwn(key, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(key)).toBe(Object.prototype);
  const absent = ItemsOperations.optional.decodeNativePathInput({}).right;
  expect(Object.hasOwn(absent, "name")).toBe(true);
  expect(absent.name).toBeUndefined();
  for (const params of [
    { first: "Ab", second: "Cd" },
    { first: "", second: "x" },
  ]) {
    expect(ItemsOperations.pair.decodeNativePathInput(params)).toEqual(
      decodePathInput(ItemsInput.pair.decode, params, true),
    );
  }

  const originalTest = RegExp.prototype.test;
  let checks = 0;
  RegExp.prototype.test = function (value) {
    if (this.source === "^[A-Z]") checks++;
    return originalTest.call(this, value);
  };
  try {
    decodePathInput(ItemsInput.pattern.decode, { name: "ab" }, true);
    const expectedChecks = checks;
    checks = 0;
    ItemsOperations.pattern.decodeNativePathInput({ name: "ab" });
    expect(checks).toBe(expectedChecks);
  } finally {
    RegExp.prototype.test = originalTest;
  }
});
