import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { Decoders, Validators } from "../../http-server/src/index.js";
import { buildEmitter, cleanupFixtures, compileFixture } from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter, 120_000);

test("flat JSON decoders preserve values, diagnostics, property safety and read order", async () => {
  const result = compileFixture(
    "flat-object",
    `
    import "@typespec/http";
    using TypeSpec.Http;
    @service namespace FlatApi;
    @minLength(1) scalar Name extends string;
    model Input {
      @encodedName("application/json", "wire-name")
      @maxLength(8) @pattern("^[A-Z]", "Capital required.") name: Name;
      @minValue(0) @maxValue(10) count: int32;
      safe?: safeint;
      tag?: string;
    }
    model Keys {
      __proto__: string;
      constructor?: string;
      @encodedName("application/json", "a.b") toString: string;
    }
    interface Items {
      @route("/input") @post input(@body body: Input): void;
      @route("/keys") @post keys(@body body: Keys): void;
    }
  `,
  );
  result.typecheck("flat-api");
  const source = result.readFile("flat-api", "server-operations.ts");
  expect(source).toContain("const prototype = Object.getPrototypeOf(input)");
  appendFileSync(`${result.outputDir}/flat-api/server-operations.ts`, "\nexport { ItemsInput };\n");
  const { ItemsInput } = await import(`${result.outputDir}/flat-api/server-operations.ts`);
  const actual = ItemsInput.input.json;
  const expected = Decoders.object(
    {
      name: Decoders.string.validate(
        Validators.minLength(1),
        Validators.maxLength(8),
        Validators.pattern("^[A-Z]", "Capital required."),
      ),
      count: Decoders.strictInteger
        .validate(Validators.minValue(-2147483648), Validators.maxValue(2147483647))
        .validate(Validators.minValue(0), Validators.maxValue(10)),
      safe: Decoders.strictSafeInteger.optional(),
      tag: Decoders.string.optional(),
    },
    { allowUnknown: true, wireNames: { name: "wire-name" } },
  );
  const inputs: unknown[] = [
    null,
    undefined,
    [],
    1,
    "text",
    new Date(),
    {},
    Object.create({ "wire-name": "A", count: 1 }),
    Object.assign(Object.create(null), { "wire-name": "A", count: 1 }),
    { "wire-name": "A", count: 1, ignored: BigInt(4) },
  ];
  for (const name of [undefined, null, "", "a", "A", "Abcdefghi", 1]) {
    for (const count of [undefined, null, "1", -1, 0, 10, 11, 1.5, Infinity, 2 ** 53]) {
      inputs.push({ "wire-name": name, count, safe: 2 ** 53, tag: null });
      inputs.push({ "wire-name": name, count, safe: 2 ** 53 - 1, tag: "tag" });
    }
  }
  for (const input of inputs) expect(actual.decode(input)).toEqual(expected.decode(input));

  for (const name of ["A", "a", "", 1]) {
    const runs = [expected, actual].map((decoder) => {
      const reads: string[] = [];
      const value = new Proxy(
        {
          get "wire-name"() {
            reads.push("name");
            return name;
          },
          get count() {
            reads.push("count");
            return 100;
          },
          get ignored() {
            throw new Error("Unknown fields must not be read");
          },
        },
        {
          getPrototypeOf(target) {
            reads.push("prototype");
            return Reflect.getPrototypeOf(target);
          },
          getOwnPropertyDescriptor(target, key) {
            reads.push(`own ${String(key)}`);
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        },
      );
      return { result: decoder.decode(value), reads };
    });
    expect(runs[1]).toEqual(runs[0]);
  }

  const events: string[] = [];
  const input = new Proxy(
    {
      get "wire-name"() {
        events.push("name");
        return "A";
      },
      get count() {
        events.push("count");
        return 1;
      },
      get ignored() {
        throw new Error("Unknown fields must not be read");
      },
    },
    {
      getPrototypeOf(target) {
        events.push("prototype");
        return Reflect.getPrototypeOf(target);
      },
      getOwnPropertyDescriptor(target, key) {
        events.push(`own ${String(key)}`);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    },
  );
  const originalTest = RegExp.prototype.test;
  RegExp.prototype.test = function (value) {
    events.push("validate name");
    return originalTest.call(this, value);
  };
  try {
    expect(actual.decode(input)._tag).toBe("Right");
  } finally {
    RegExp.prototype.test = originalTest;
  }
  expect(events).toEqual([
    "prototype",
    "own wire-name",
    "name",
    "validate name",
    "own count",
    "count",
    "own safe",
    "own tag",
  ]);

  const keys = ItemsInput.keys.json.decode(JSON.parse('{"__proto__":"safe","a.b":"method"}'));
  expect(keys._tag).toBe("Right");
  expect(Object.getPrototypeOf(keys.right)).toBe(Object.prototype);
  expect(Object.keys(keys.right)).toEqual(["__proto__", "toString"]);
  expect(keys.right.__proto__).toBe("safe");
  expect(keys.right.toString).toBe("method");
});
