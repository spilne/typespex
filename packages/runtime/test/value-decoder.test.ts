import { describe, expect, test } from "bun:test";
import {
  type Decoder,
  Decoders,
  Either,
  UnsupportedMediaTypeError,
  Validators,
  ValidationError,
  decode,
  decodeBody,
  decodeJsonBodyOrThrow,
  decodeJsonBody,
  decodeFormBody,
  decodeMultipartBody,
  decodeOptional,
  decodeOptionalOrThrow,
  decodeOrThrow,
  decodeRequired,
  decodeRequiredOrThrow,
  fail,
  isRight,
  prefixIssues,
  succeed,
  toValidationResult,
  traverseEither,
} from "../src/server.js";

/** Assert a Left with expected issues. Decoder.decode returns issue arrays directly. */
function expectLeftIssues(
  decoded: ReturnType<typeof Decoders.string.decode>,
  issues: readonly { path: string; message: string }[],
): void {
  expect(decoded._tag).toBe("Left");
  if (decoded._tag === "Left") {
    expect(decoded.left).toEqual(issues);
  }
}

describe("http decoder - primitives", () => {
  test("Decoders namespace exposes preferred value decoders", () => {
    const decoder = Decoders.object<{ name: string; age?: number }>({
      name: Decoders.string,
      age: Decoders.optional(Decoders.number),
    });

    expect(decoder.decode({ name: "Ada", age: "42" })).toEqual(
      Either.right({ name: "Ada", age: 42 }),
    );
  });

  test("Either.getOrElse", () => {
    expect(Either.getOrElse(Either.right(42), 0)).toBe(42);
    expect(Either.getOrElse(Either.left("nope"), 0)).toBe(0);

    let evaluated = 0;
    expect(
      Either.getOrElseEval(Either.left("nope"), () => {
        evaluated += 1;
        return 7;
      }),
    ).toBe(7);
    expect(evaluated).toBe(1);

    expect(
      Either.getOrElseEval(Either.right(1), () => {
        evaluated += 1;
        return 9;
      }),
    ).toBe(1);
    expect(evaluated).toBe(1);
  });

  test("Either.getOrElseThrow", () => {
    expect(Either.getOrElseThrow(Either.right(42))).toBe(42);

    expect(() => Either.getOrElseThrow(Either.left(new Error("left-boom")))).toThrow("left-boom");
  });

  test("Either.fold", () => {
    expect(
      Either.fold(
        Either.right(42),
        () => "left",
        (n) => `right:${n}`,
      ),
    ).toBe("right:42");
    expect(
      Either.fold(
        Either.left("err"),
        (e) => `left:${e}`,
        () => "right",
      ),
    ).toBe("left:err");
  });

  test("Either.mapLeft", () => {
    const mapped = Either.mapLeft(Either.left(1), (n) => n + 1);
    expect(mapped).toEqual(Either.left(2));

    const unchanged = Either.mapLeft(Either.right("ok"), () => 99);
    expect(unchanged).toEqual(Either.right("ok"));
  });

  test("Either.orElse", () => {
    expect(Either.orElse(Either.right(1), () => Either.right(2))).toEqual(Either.right(1));
    expect(Either.orElse(Either.left("a"), () => Either.right(2))).toEqual(Either.right(2));
    expect(Either.orElse(Either.left("a"), () => Either.left("b"))).toEqual(Either.left("b"));
  });

  test("Decoders.string", () => {
    expect(Decoders.string.decode("ok")).toEqual(Either.right("ok"));
    expectLeftIssues(Decoders.string.decode(42), [{ path: "", message: "Expected a string." }]);
  });

  test("Decoders.number", () => {
    expect(Decoders.number.decode(42)).toEqual(Either.right(42));
    expect(Decoders.number.decode("42.5")).toEqual(Either.right(42.5));
    expect(Decoders.number.decode(0)).toEqual(Either.right(0));
    expect(Decoders.number.decode(-3.14)).toEqual(Either.right(-3.14));
    expectLeftIssues(Decoders.number.decode("Infinity"), [
      { path: "", message: "Expected a finite number." },
    ]);
    expectLeftIssues(Decoders.number.decode(Infinity), [
      { path: "", message: "Expected a finite number." },
    ]);
    expectLeftIssues(Decoders.number.decode(-Infinity), [
      { path: "", message: "Expected a finite number." },
    ]);
    expectLeftIssues(Decoders.number.decode("NaN"), [
      { path: "", message: "Expected a finite number." },
    ]);
    expectLeftIssues(Decoders.number.decode(""), [
      { path: "", message: "Expected a finite number." },
    ]);
    expectLeftIssues(Decoders.number.decode(" 42 "), [
      { path: "", message: "Expected a finite number." },
    ]);
    expectLeftIssues(Decoders.number.decode("0x2a"), [
      { path: "", message: "Expected a finite number." },
    ]);
  });

  test("Decoders.bigint", () => {
    expect(Decoders.bigint.decode(42n)).toEqual(Either.right(42n));
    expect(Decoders.bigint.decode(42)).toEqual(Either.right(42n));
    expect(Decoders.bigint.decode("42")).toEqual(Either.right(42n));
    expectLeftIssues(Decoders.bigint.decode("42.1"), [
      { path: "", message: "Expected a valid integer." },
    ]);
  });

  test("Decoders.boolean", () => {
    expect(Decoders.boolean.decode(true)).toEqual(Either.right(true));
    expect(Decoders.boolean.decode("true")).toEqual(Either.right(true));
    expect(Decoders.boolean.decode("false")).toEqual(Either.right(false));
    expectLeftIssues(Decoders.boolean.decode("TRUE"), [
      { path: "", message: 'Expected "true" or "false".' },
    ]);
  });

  test("strict primitive decoders do not coerce JSON strings", () => {
    expect(Decoders.strictNumber.decode(42)).toEqual(Either.right(42));
    expect(Decoders.strictBigint.decode(42)).toEqual(Either.right(42n));
    expect(Decoders.strictBoolean.decode(true)).toEqual(Either.right(true));
    expectLeftIssues(Decoders.strictNumber.decode("42"), [
      { path: "", message: "Expected a finite number." },
    ]);
    expectLeftIssues(Decoders.strictBigint.decode("42"), [
      { path: "", message: "Expected a valid integer." },
    ]);
    expectLeftIssues(Decoders.strictBoolean.decode("true"), [
      { path: "", message: "Expected a boolean." },
    ]);
  });

  test("integer decoders reject fractional and unsafe values", () => {
    expect(Decoders.integer.decode("42")).toEqual(Either.right(42));
    expect(Decoders.safeInteger.decode("42")).toEqual(Either.right(42));
    expectLeftIssues(Decoders.integer.decode("42.5"), [
      { path: "", message: "Expected an integer." },
    ]);
    expectLeftIssues(Decoders.integer.decode("9007199254740992"), [
      { path: "", message: "Expected an integer." },
    ]);
    expectLeftIssues(Decoders.safeInteger.decode("9007199254740992"), [
      { path: "", message: "Expected a safe integer." },
    ]);
    expectLeftIssues(Decoders.bigint.decode(9007199254740992), [
      { path: "", message: "Expected a valid integer." },
    ]);
  });

  test("Decoders.bytes", () => {
    expect(Decoders.bytes.decode(new Uint8Array([1, 2, 3]))).toEqual(
      Either.right(new Uint8Array([1, 2, 3])),
    );

    const fromBase64 = Decoders.bytes.decode("AQID");
    expect(fromBase64._tag).toBe("Right");
    if (fromBase64._tag === "Right") {
      expect([...fromBase64.right]).toEqual([1, 2, 3]);
    }

    expect(Decoders.bytes.decode([0, 255])).toEqual(Either.right(new Uint8Array([0, 255])));
    expectLeftIssues(Decoders.bytes.decode([0, 999]), [
      { path: "[1]", message: "Expected a byte value between 0 and 255." },
    ]);
    expectLeftIssues(Decoders.bytes.decode({ nope: true }), [
      { path: "", message: "Expected a base64 string or byte array." },
    ]);
  });

  test("Decoders.strictBytes accepts only the JSON base64 representation", () => {
    expect(Decoders.strictBytes.decode("AQID")).toEqual(Either.right(new Uint8Array([1, 2, 3])));
    expectLeftIssues(Decoders.strictBytes.decode([1, 2, 3]), [
      { path: "", message: "Expected a base64 string." },
    ]);
    expectLeftIssues(Decoders.strictBytes.decode(new Uint8Array([1, 2, 3])), [
      { path: "", message: "Expected a base64 string." },
    ]);
  });

  test("Decoders.unknown", () => {
    const value = { any: ["shape"] };
    expect(Decoders.unknown.decode(value)).toEqual(Either.right(value));
  });
});

describe("http decoder - combinators", () => {
  test("Decoders.literal", () => {
    expect(Decoders.literal("x").decode("x")).toEqual(Either.right("x"));
    expect(Decoders.literal(5).decode("5")).toEqual(Either.right(5));
    expect(Decoders.literal(true).decode("true")).toEqual(Either.right(true));
    expect(Decoders.literal(null).decode("null")).toEqual(Either.right(null));
    expect(Decoders.literal(9223372036854775807n).decode("9223372036854775807")).toEqual(
      Either.right(9223372036854775807n),
    );
    expectLeftIssues(Decoders.literal("x").decode("y"), [
      { path: "", message: 'Expected literal "x".' },
    ]);
  });

  test("Decoders.array supports array input and text singleton input", () => {
    expect(Decoders.array(Decoders.number).decode([1, "2"])).toEqual(Either.right([1, 2]));
    expect(Decoders.array(Decoders.number).decode("3")).toEqual(Either.right([3]));
    expectLeftIssues(Decoders.array(Decoders.number).decode({ nope: true }), [
      { path: "", message: "Expected an array." },
    ]);
    expectLeftIssues(Decoders.array(Decoders.number).decode(["1", "bad"]), [
      { path: "[1]", message: "Expected a finite number." },
    ]);
  });

  test("Decoders.strictArray rejects non-array inputs", () => {
    expect(Decoders.strictArray(Decoders.number).decode([1, "2"])).toEqual(Either.right([1, 2]));
    // Unlike Decoders.array, Decoders.strictArray rejects lone strings
    expectLeftIssues(Decoders.strictArray(Decoders.number).decode("3"), [
      { path: "", message: "Expected an array." },
    ]);
    expectLeftIssues(Decoders.strictArray(Decoders.number).decode({ nope: true }), [
      { path: "", message: "Expected an array." },
    ]);
    expectLeftIssues(Decoders.strictArray(Decoders.number).decode(["1", "bad"]), [
      { path: "[1]", message: "Expected a finite number." },
    ]);
  });

  test("Decoders.tuple validates length and item decoders", () => {
    const decoder = Decoders.tuple<[string, number]>([Decoders.string, Decoders.number]);
    expect(decoder.decode(["a", "1"])).toEqual(Either.right(["a", 1]));
    expectLeftIssues(decoder.decode(["a"]), [
      { path: "", message: "Expected a tuple of length 2." },
    ]);
    expectLeftIssues(decoder.decode(["a", "x"]), [
      { path: "[1]", message: "Expected a finite number." },
    ]);
  });

  test("Decoders.record", () => {
    const decoder = Decoders.record(Decoders.number);
    expect(decoder.decode({ a: "1", b: 2 })).toEqual(Either.right({ a: 1, b: 2 }));
    expectLeftIssues(decoder.decode([]), [{ path: "", message: "Expected an object." }]);
    expectLeftIssues(decoder.decode({ a: "bad" }), [
      { path: ".a", message: "Expected a finite number." },
    ]);
  });

  test("Decoders.object required/optional/unknown fields", () => {
    const decoder = Decoders.object<{
      name: string;
      age?: number;
    }>({
      name: Decoders.string,
      age: Decoders.optional(Decoders.number),
    });

    expect(decoder.decode({ name: "ok" })).toEqual(Either.right({ name: "ok" }));
    expect(decoder.decode({ name: "ok", age: "2" })).toEqual(Either.right({ name: "ok", age: 2 }));

    expectLeftIssues(decoder.decode({ age: 2 }), [
      { path: ".name", message: "Expected a string." },
    ]);

    expectLeftIssues(decoder.decode({ name: "ok", extra: true }), [
      { path: ".extra", message: "Unexpected field." },
    ]);

    const allowUnknown = Decoders.object<{ name: string }>(
      { name: Decoders.string },
      { allowUnknown: true },
    );
    expect(allowUnknown.decode({ name: "ok", extra: true })).toEqual(Either.right({ name: "ok" }));
  });

  test("Decoders.object maps JSON wire names to handler properties", () => {
    const decoder = Decoders.object<{ userName: string; optionalValue?: number }>(
      {
        userName: Decoders.string,
        optionalValue: Decoders.optional(Decoders.strictNumber),
      },
      {
        wireNames: {
          userName: "user_name",
          optionalValue: "optional_value",
        },
      },
    );

    expect(decoder.decode({ user_name: "Milo" })).toEqual(Either.right({ userName: "Milo" }));
    expect(decoder.decode({ user_name: 42 })).toEqual(
      Either.left([{ path: ".user_name", message: "Expected a string." }]),
    );
    expect(decoder.decode({ userName: "Milo" })).toEqual(
      Either.left([
        { path: ".user_name", message: "Expected a string." },
        { path: ".userName", message: "Unexpected field." },
      ]),
    );
  });

  test("Decoders.object validates and preserves additional properties", () => {
    interface FlexiblePerson {
      age: number;
      [key: string]: string | number;
    }

    const decoder = Decoders.object<FlexiblePerson>(
      { age: Decoders.number },
      { additionalProperties: Decoders.string },
    );

    expect(decoder.decode({ age: "42", nickname: "Ada" })).toEqual(
      Either.right({ age: 42, nickname: "Ada" }),
    );
    expectLeftIssues(decoder.decode({ nickname: "Ada" }), [
      { path: ".age", message: "Expected a finite number." },
    ]);
    expectLeftIssues(decoder.decode({ age: 42, score: 100 }), [
      { path: ".score", message: "Expected a string." },
    ]);
  });

  test("additional-property decoding accumulates declared, nested, and forbidden issues", () => {
    const additional = Decoders.object<{ enabled: boolean }>({
      enabled: Decoders.strictBoolean,
    });
    const decoder = Decoders.object<{ id: string }>(
      { id: Decoders.string },
      {
        additionalProperties: additional,
        forbiddenProperties: ["metadata"],
      },
    );

    expectLeftIssues(
      decoder.decode({
        id: 10,
        first: { enabled: "yes" },
        second: 42,
        metadata: { enabled: true },
      }),
      [
        { path: ".id", message: "Expected a string." },
        { path: ".first.enabled", message: "Expected a boolean." },
        { path: ".second", message: "Expected an object." },
        { path: ".metadata", message: "Unexpected field." },
      ],
    );
  });

  test("forbidden object properties override unknown and additional-property policies", () => {
    const dropUnknown = Decoders.object<{ name: string }>(
      { name: Decoders.string },
      {
        allowUnknown: true,
        forbiddenProperties: ["hidden"],
      },
    );
    expectLeftIssues(dropUnknown.decode({ name: "ok", extra: true, hidden: "nope" }), [
      { path: ".hidden", message: "Unexpected field." },
    ]);

    const preserveAdditional = Decoders.object<{ name: string }>(
      { name: Decoders.string },
      {
        additionalProperties: Decoders.string,
        forbiddenProperties: ["hidden"],
      },
    );
    expectLeftIssues(preserveAdditional.decode({ name: "ok", extra: "yes", hidden: "nope" }), [
      { path: ".hidden", message: "Unexpected field." },
    ]);
  });

  test("Decoders.never rejects every value and can seal additional properties", () => {
    expectLeftIssues(Decoders.never.decode(undefined), [
      { path: "", message: "Expected no value." },
    ]);
    expectLeftIssues(Decoders.never.decode("anything"), [
      { path: "", message: "Expected no value." },
    ]);

    const decoder = Decoders.object(
      {},
      {
        additionalProperties: Decoders.never,
      },
    );
    expect(decoder.decode({})).toEqual(Either.right({}));
    expectLeftIssues(decoder.decode({ extra: true }), [
      { path: ".extra", message: "Expected no value." },
    ]);
  });

  test("object and record decoders preserve prototype-sensitive own keys", () => {
    const input = JSON.parse('{"__proto__":"proto","constructor":"ctor"}') as Record<
      string,
      unknown
    >;
    const record = Decoders.record(Decoders.string).decode(input);
    expect(record._tag).toBe("Right");
    if (record._tag === "Right") {
      expect(Object.getPrototypeOf(record.right)).toBe(Object.prototype);
      expect(Object.prototype.hasOwnProperty.call(record.right, "__proto__")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(record.right, "constructor")).toBe(true);
      expect(record.right["__proto__"]).toBe("proto");
      expect(record.right.constructor).toBe("ctor");
    }

    const fields = Object.create(null) as Record<string, typeof Decoders.string>;
    fields["__proto__"] = Decoders.string;
    fields.constructor = Decoders.string;
    const object = Decoders.object<Record<string, string>>(fields).decode(input);
    expect(object._tag).toBe("Right");
    if (object._tag === "Right") {
      expect(Object.getPrototypeOf(object.right)).toBe(Object.prototype);
      expect(object.right["__proto__"]).toBe("proto");
      expect(object.right.constructor).toBe("ctor");
    }
  });

  test("additional-property decoding safely preserves prototype-sensitive own keys", () => {
    const input = JSON.parse(
      '{"name":"safe","__proto__":"proto","constructor":"ctor","toString":"stringifier"}',
    ) as Record<string, unknown>;
    const decoded = Decoders.object<{ name: string }>(
      { name: Decoders.string },
      { additionalProperties: Decoders.string },
    ).decode(input);

    expect(decoded._tag).toBe("Right");
    if (decoded._tag === "Right") {
      const result = decoded.right as Record<string, unknown>;
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(result, "constructor")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(result, "toString")).toBe(true);
      expect(result["__proto__"]).toBe("proto");
      expect(result.constructor).toBe("ctor");
      expect(result.toString).toBe("stringifier");
    }
  });

  test("forbidden-property checks safely match prototype-sensitive names", () => {
    const input = JSON.parse(
      '{"name":"safe","__proto__":"proto","constructor":"ctor","toString":"stringifier"}',
    ) as Record<string, unknown>;
    const decoded = Decoders.object<{ name: string }>(
      { name: Decoders.string },
      {
        allowUnknown: true,
        forbiddenProperties: ["__proto__", "constructor", "toString"],
      },
    ).decode(input);

    expectLeftIssues(decoded, [
      { path: ".__proto__", message: "Unexpected field." },
      { path: ".constructor", message: "Unexpected field." },
      { path: ".toString", message: "Unexpected field." },
    ]);
  });

  test("unknown-field checks do not treat Object.prototype keys as declared", () => {
    const input = JSON.parse('{"__proto__":"nope"}') as Record<string, unknown>;
    expectLeftIssues(Decoders.object({}).decode(input), [
      { path: ".__proto__", message: "Unexpected field." },
    ]);
  });

  test("object decoders require own fields on plain objects", () => {
    const inherited = Object.create({ role: "admin" }) as { role: string };
    const decoder = Decoders.object<{ role: string }>({ role: Decoders.string });

    expectLeftIssues(decoder.decode(inherited), [
      { path: "", message: "Expected a plain object." },
    ]);
    expectLeftIssues(
      decoder.decode(
        new (class Payload {
          role = "admin";
        })(),
      ),
      [{ path: "", message: "Expected a plain object." }],
    );
  });

  test("Decoders.union and Decoders.nullable", () => {
    const union = Decoders.union<string | number>([Decoders.string, Decoders.number]);
    expect(union.decode("x")).toEqual(Either.right("x"));
    expect(union.decode(2)).toEqual(Either.right(2));
    expectLeftIssues(union.decode({}), [
      { path: "", message: "Value did not match any allowed variant." },
    ]);

    const nullable = Decoders.nullable(Decoders.number);
    expect(nullable.decode(null)).toEqual(Either.right(null));
    expect(nullable.decode("null")).toEqual(Either.right(null));
    expect(nullable.decode("2")).toEqual(Either.right(2));
  });

  test("Decoders.union infers the union of member outputs", () => {
    const literalUnion: Decoder<"active" | "archived"> = Decoders.union([
      Decoders.literal("active"),
      Decoders.literal("archived"),
    ]);
    const mixedUnion: Decoder<string | number> = Decoders.union([Decoders.string, Decoders.number]);

    expect(literalUnion.decode("active")).toEqual(Either.right("active"));
    expect(literalUnion.decode("missing")._tag).toBe("Left");
    expect(mixedUnion.decode("value")).toEqual(Either.right("value"));
    expect(mixedUnion.decode(42)).toEqual(Either.right(42));
  });

  test("Decoders.lazy resolves once and delegates decoding", () => {
    let resolved = 0;
    const lazy = Decoders.lazy(() => {
      resolved += 1;
      return Decoders.union<number | null>([Decoders.number, Decoders.literal(null)]);
    });

    expect(lazy.decode("2")).toEqual(Either.right(2));
    expect(lazy.decode(null)).toEqual(Either.right(null));
    expect(resolved).toBe(1);
  });

  test("Decoders.discriminated dispatches by tag field", () => {
    const catDecoder = Decoders.object<{ type: "cat"; lives: number }>({
      type: Decoders.literal("cat"),
      lives: Decoders.number,
    });
    const dogDecoder = Decoders.object<{ type: "dog"; breed: string }>({
      type: Decoders.literal("dog"),
      breed: Decoders.string,
    });

    const animalDecoder = Decoders.discriminated<
      { type: "cat"; lives: number } | { type: "dog"; breed: string }
    >("type", { cat: catDecoder, dog: dogDecoder });

    expect(animalDecoder.decode({ type: "cat", lives: 9 })).toEqual(
      Either.right({ type: "cat", lives: 9 }),
    );
    expect(animalDecoder.decode({ type: "dog", breed: "lab" })).toEqual(
      Either.right({ type: "dog", breed: "lab" }),
    );
    expectLeftIssues(animalDecoder.decode({ type: "fish" }), [
      { path: ".type", message: 'Unknown discriminator value: "fish".' },
    ]);
    expectLeftIssues(animalDecoder.decode("not-object"), [
      { path: "", message: "Expected an object." },
    ]);
  });

  test("Decoders.discriminated handles number discriminator values", () => {
    const v1Decoder = Decoders.object<{ version: 1; data: string }>({
      version: Decoders.literal(1),
      data: Decoders.string,
    });
    const v2Decoder = Decoders.object<{ version: 2; items: number[] }>({
      version: Decoders.literal(2),
      items: Decoders.array(Decoders.number),
    });

    const decoder = Decoders.discriminated<
      { version: 1; data: string } | { version: 2; items: number[] }
    >("version", { "1": v1Decoder, "2": v2Decoder });

    expect(decoder.decode({ version: 1, data: "hello" })).toEqual(
      Either.right({ version: 1, data: "hello" }),
    );
    expect(decoder.decode({ version: 2, items: [1, 2] })).toEqual(
      Either.right({ version: 2, items: [1, 2] }),
    );
    expectLeftIssues(decoder.decode({ version: 3 }), [
      { path: ".version", message: "Unknown discriminator value: 3." },
    ]);
  });

  test("Decoders.discriminated handles bigint discriminator values", () => {
    const max = 9223372036854775807n;
    const maxDecoder = Decoders.object<{ version: 9223372036854775807n; data: string }>({
      version: Decoders.literal(max),
      data: Decoders.string,
    });
    const decoder = Decoders.discriminated<{ version: 9223372036854775807n; data: string }>(
      "version",
      { [String(max)]: maxDecoder },
    );

    expect(decoder.decode({ version: max, data: "exact" })).toEqual(
      Either.right({ version: max, data: "exact" }),
    );
    expectLeftIssues(decoder.decode({ version: max - 1n }), [
      { path: ".version", message: "Unknown discriminator value: 9223372036854775806n." },
    ]);
  });

  test("Decoders.discriminated delegates unknown tags to a default variant", () => {
    type Value = { kind: "known"; value: string } | { kind: string; raw: number };
    const decoder = Decoders.discriminated<Value>(
      "kind",
      {
        known: Decoders.object<{ kind: "known"; value: string }>({
          kind: Decoders.literal("known"),
          value: Decoders.string,
        }),
      },
      {
        defaultVariant: Decoders.object<{ kind: string; raw: number }>({
          kind: Decoders.string,
          raw: Decoders.number,
        }),
      },
    );

    expect(decoder.decode({ kind: "future", raw: 2 })).toEqual(
      Either.right({ kind: "future", raw: 2 }),
    );
    expectLeftIssues(decoder.decode({ raw: 2 }), [
      { path: ".kind", message: "Unknown discriminator value: undefined." },
    ]);
  });

  test("Decoders.discriminated treats prototype names as own-key variants only", () => {
    const fallbackDecoder = Decoders.discriminated("kind", {
      known: Decoders.object({ kind: Decoders.literal("known") }),
    });

    for (const kind of ["constructor", "toString", "__proto__"]) {
      expectLeftIssues(fallbackDecoder.decode({ kind }), [
        { path: ".kind", message: `Unknown discriminator value: ${JSON.stringify(kind)}.` },
      ]);
    }

    const prototypeDecoder = Decoders.object<{ kind: "__proto__"; value: string }>({
      kind: Decoders.literal("__proto__"),
      value: Decoders.string,
    });
    const declaredDecoder = Decoders.discriminated<{ kind: "__proto__"; value: string }>("kind", {
      ["__proto__"]: prototypeDecoder,
    });

    expect(declaredDecoder.decode({ kind: "__proto__", value: "safe" })).toEqual(
      Either.right({ kind: "__proto__", value: "safe" }),
    );
  });

  test("Decoders.discriminated ignores inherited discriminator values", () => {
    const discriminator = "__typespex_inherited_discriminator__";
    const decoder = Decoders.discriminated(discriminator, {
      polluted: Decoders.unknown,
    });

    Object.defineProperty(Object.prototype, discriminator, {
      configurable: true,
      value: "polluted",
    });
    try {
      expectLeftIssues(decoder.decode({}), [
        {
          path: `.${discriminator}`,
          message: "Unknown discriminator value: undefined.",
        },
      ]);
    } finally {
      delete (Object.prototype as Record<string, unknown>)[discriminator];
    }
  });

  test("nested object validation reports precise relative paths", () => {
    const decoder = Decoders.object<{
      name: string;
      tag?: "cat" | "dog";
      scores: number[];
    }>({
      name: Decoders.string,
      tag: Decoders.optional(
        Decoders.union<"cat" | "dog">([Decoders.literal("cat"), Decoders.literal("dog")]),
      ),
      scores: Decoders.array(Decoders.number),
    });

    const decoded = decoder.decode({
      name: "milo",
      tag: "fish",
      scores: [1, "bad"],
    });

    expect(decoded._tag).toBe("Left");
    if (decoded._tag === "Left") {
      expect(decoded.left).toEqual([
        { path: ".tag", message: "Value did not match any allowed variant." },
        { path: ".scores[1]", message: "Expected a finite number." },
      ]);
    }
  });

  test("decode boundary function prefixes root", () => {
    const decoder = Decoders.object<{ name: string; scores: number[] }>({
      name: Decoders.string,
      scores: Decoders.array(Decoders.number),
    });

    const result = decode(decoder, { scores: [1, "bad"] }, "$");
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.issues).toEqual([
        { path: "$.name", message: "Expected a string." },
        { path: "$.scores[1]", message: "Expected a finite number." },
      ]);
    }
  });
});

describe("http decoder - transformers", () => {
  test("Decoder.map transforms decoded value", () => {
    const trimmed = Decoders.string.map((s) => s.trim());
    expect(trimmed.decode("  hello  ")).toEqual(Either.right("hello"));
    expectLeftIssues(trimmed.decode(42), [{ path: "", message: "Expected a string." }]);
  });

  test("Decoders.refine adds validation constraint", () => {
    const positive = Decoders.refine(Decoders.number, (n) => n > 0, "Must be positive.");
    expect(positive.decode(5)).toEqual(Either.right(5));
    expect(positive.decode("3")).toEqual(Either.right(3));
    expectLeftIssues(positive.decode(-1), [{ path: "", message: "Must be positive." }]);

    const maxLen = Decoders.refine(
      Decoders.string,
      (s) => s.length <= 5,
      (s) => `Too long: ${s.length} > 5`,
    );
    expectLeftIssues(maxLen.decode("toolong"), [{ path: "", message: "Too long: 7 > 5" }]);
  });

  test("Decoder.validate accumulates validator issues", () => {
    const decoder = Decoders.string.validate(
      Validators.minLength(3),
      Validators.pattern("^[a-z]+$", "Must be lower-case letters."),
    );

    expect(decoder.decode("abc")).toEqual(Either.right("abc"));
    expectLeftIssues(decoder.decode("A"), [
      { path: "", message: "Expected length greater than or equal to 3." },
      { path: "", message: "Must be lower-case letters." },
    ]);
  });

  test("Validators cover numeric, length, item, and pattern checks", () => {
    expect(Decoders.number.validate(Validators.minValue(1)).decode(1)).toEqual(Either.right(1));
    expectLeftIssues(Decoders.number.validate(Validators.minValueExclusive(1)).decode(1), [
      { path: "", message: "Expected a value greater than 1." },
    ]);
    expectLeftIssues(Decoders.number.validate(Validators.maxValue(5)).decode(6), [
      { path: "", message: "Expected a value less than or equal to 5." },
    ]);
    expectLeftIssues(Decoders.number.validate(Validators.maxValueExclusive(5)).decode(5), [
      { path: "", message: "Expected a value less than 5." },
    ]);
    expectLeftIssues(
      Decoders.array(Decoders.string).validate(Validators.minItems(2)).decode(["one"]),
      [{ path: "", message: "Expected at least 2 item(s)." }],
    );
    expectLeftIssues(
      Decoders.array(Decoders.string).validate(Validators.maxItems(1)).decode(["one", "two"]),
      [{ path: "", message: "Expected at most 1 item(s)." }],
    );
    expectLeftIssues(Decoders.string.validate(Validators.maxLength(2)).decode("abc"), [
      { path: "", message: "Expected length less than or equal to 2." },
    ]);
  });
});

describe("http decoder - exported building blocks", () => {
  test("succeed wraps a value in Right", () => {
    expect(succeed(42)).toEqual(Either.right(42));
  });

  test("fail creates a single-issue Left", () => {
    const result = fail("", "oops");
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toEqual([{ path: "", message: "oops" }]);
    }
  });

  test("traverseEither accumulates errors", () => {
    const result = traverseEither([1, -2, 3, -4], (n, i) =>
      n > 0 ? succeed(n) : fail(`[${i}]`, `Negative: ${n}`),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toEqual([
        { path: "[1]", message: "Negative: -2" },
        { path: "[3]", message: "Negative: -4" },
      ]);
    }

    const ok = traverseEither([1, 2, 3], (n) => succeed(n * 2));
    expect(ok).toEqual(Either.right([2, 4, 6]));
  });
});

describe("http decoder - throw adapters", () => {
  test("decodeOrThrow", () => {
    expect(decodeOrThrow(Decoders.number, "12", "$query.limit")).toBe(12);
    expect(() => decodeOrThrow(Decoders.number, "bad", "$query.limit")).toThrow(ValidationError);
  });

  test("decodeRequiredOrThrow", () => {
    expect(decodeRequiredOrThrow(Decoders.string, "x", "$path.id")).toBe("x");
    expect(() => decodeRequiredOrThrow(Decoders.string, undefined, "$path.id")).toThrow(
      ValidationError,
    );
  });

  test("decodeRequired", () => {
    expect(decodeRequired(Decoders.string, "x")).toEqual(Either.right("x"));
    const decoded = decodeRequired(Decoders.string, undefined);
    expect(decoded._tag).toBe("Left");
    if (decoded._tag === "Left") {
      expect(decoded.left).toEqual([{ path: "", message: "Required value is missing." }]);
    }
  });

  test("decodeOptionalOrThrow", () => {
    expect(decodeOptionalOrThrow(Decoders.string, undefined, "$query.q")).toBeUndefined();
    expect(decodeOptionalOrThrow(Decoders.string, "x", "$query.q")).toBe("x");
    expect(() => decodeOptionalOrThrow(Decoders.number, "bad", "$query.limit")).toThrow(
      ValidationError,
    );
  });

  test("decodeOptional", () => {
    expect(decodeOptional(Decoders.string, undefined)).toEqual(Either.right(undefined));
    expect(decodeOptional(Decoders.string, "x")).toEqual(Either.right("x"));
  });

  test("decodeJsonBodyOrThrow", async () => {
    const okRequest = new Request("http://localhost/test", {
      method: "POST",
      body: JSON.stringify({ id: "42" }),
      headers: { "content-type": "application/json" },
    });
    const value = await decodeJsonBodyOrThrow(
      okRequest,
      Decoders.object<{ id: string }>({ id: Decoders.string }),
    );
    expect(value).toEqual({ id: "42" });

    const invalidJsonRequest = new Request("http://localhost/test", {
      method: "POST",
      body: "{not-json",
      headers: { "content-type": "application/json" },
    });
    await expect(
      decodeJsonBodyOrThrow(invalidJsonRequest, Decoders.object({})),
    ).rejects.toBeInstanceOf(ValidationError);

    const invalidShapeRequest = new Request("http://localhost/test", {
      method: "POST",
      body: JSON.stringify({ id: 42 }),
      headers: { "content-type": "application/json" },
    });
    await expect(
      decodeJsonBodyOrThrow(
        invalidShapeRequest,
        Decoders.object<{ id: string }>({ id: Decoders.string }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("decodeJsonBody", async () => {
    const okRequest = new Request("http://localhost/test", {
      method: "POST",
      body: JSON.stringify({ id: "42" }),
      headers: { "content-type": "application/json" },
    });
    expect(
      await decodeJsonBody(okRequest, Decoders.object<{ id: string }>({ id: Decoders.string })),
    ).toEqual(Either.right({ id: "42" }));

    const invalidJsonRequest = new Request("http://localhost/test", {
      method: "POST",
      body: "{not-json",
      headers: { "content-type": "application/json" },
    });
    const decoded = await decodeJsonBody(invalidJsonRequest, Decoders.object({}));
    expect(decoded._tag).toBe("Left");
    if (decoded._tag === "Left") {
      expect((decoded.left as ValidationError).issues).toEqual([
        { path: "$body", message: "Body must contain valid JSON." },
      ]);
    }
  });

  test("decodeFormBody parses url-encoded form data", async () => {
    const okRequest = new Request("http://localhost/test", {
      method: "POST",
      body: "name=Alice&age=30",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const result = await decodeFormBody(
      okRequest,
      Decoders.object<{ name: string; age: string }>({
        name: Decoders.string,
        age: Decoders.string,
      }),
    );
    expect(result).toEqual(Either.right({ name: "Alice", age: "30" }));
  });

  test("decodeFormBody handles encoded values", async () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      body: "msg=hello+world&path=%2Ffoo%2Fbar",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const result = await decodeFormBody(
      request,
      Decoders.object<{ msg: string; path: string }>({
        msg: Decoders.string,
        path: Decoders.string,
      }),
    );
    expect(result).toEqual(Either.right({ msg: "hello world", path: "/foo/bar" }));
  });

  test("decodeFormBody collects repeated fields as arrays", async () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      body: "tag=one&tag=two",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const result = await decodeFormBody(
      request,
      Decoders.object<{ tag: string[] }>({
        tag: Decoders.strictArray(Decoders.string),
      }),
    );
    expect(result).toEqual(Either.right({ tag: ["one", "two"] }));
  });

  test("decodeFormBody validates decoded fields", async () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      body: "name=",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const result = await decodeFormBody(
      request,
      Decoders.object<{ name: string }>({
        name: Decoders.string.validate(Validators.minLength(1)),
      }),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.issues.some((i) => i.path.includes("name"))).toBe(true);
    }
  });

  test("Decoders.file accepts File instances", () => {
    const file = new File(["hello"], "test.txt", { type: "text/plain" });
    expect(Decoders.file.decode(file)).toEqual(succeed(file));
  });

  test("Decoders.file rejects non-File values", () => {
    const result = Decoders.file.decode("not a file");
    expect(result._tag).toBe("Left");
  });

  test("Decoders.fileWithContentTypes validates multipart file media", () => {
    const png = new File(["png"], "image.png", { type: "image/png" });
    const text = new File(["text"], "note.txt", { type: "text/plain" });
    const decoder = Decoders.fileWithContentTypes(["image/*"]);

    expect(decoder.decode(png)).toEqual(succeed(png));
    expect(decoder.decode(text)._tag).toBe("Left");
    expect(
      Decoders.fileWithContentTypes(["image/*"], {
        requireContentType: true,
      }).decode(new File(["untyped"], "image.bin")),
    ).toEqual(Either.left([{ path: "", message: "Expected a file content type." }]));
  });

  test("decodeMultipartBody parses multipart form data", async () => {
    const formData = new FormData();
    formData.append("name", "Alice");
    formData.append("avatar", new File(["img"], "avatar.png", { type: "image/png" }));

    const request = new Request("http://localhost/upload", {
      method: "POST",
      body: formData,
    });

    const result = await decodeMultipartBody(
      request,
      Decoders.object<{ name: string; avatar: File }>({
        name: Decoders.string,
        avatar: Decoders.file,
      }),
    );

    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right.name).toBe("Alice");
      expect(result.right.avatar).toBeInstanceOf(File);
      expect(result.right.avatar.name).toBe("avatar.png");
    }
  });

  test("decodeMultipartBody collects repeated fields as arrays", async () => {
    const formData = new FormData();
    formData.append("files", new File(["one"], "one.txt", { type: "text/plain" }));
    formData.append("files", new File(["two"], "two.txt", { type: "text/plain" }));

    const request = new Request("http://localhost/upload", {
      method: "POST",
      body: formData,
    });

    const result = await decodeMultipartBody(
      request,
      Decoders.object<{ files: File[] }>({
        files: Decoders.strictArray(Decoders.file),
      }),
    );

    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right.files.map((file) => file.name)).toEqual(["one.txt", "two.txt"]);
    }
  });

  test("decodeMultipartBody validates fields", async () => {
    const formData = new FormData();
    formData.append("name", "");

    const request = new Request("http://localhost/upload", {
      method: "POST",
      body: formData,
    });

    const result = await decodeMultipartBody(
      request,
      Decoders.object<{ name: string }>({
        name: Decoders.string.validate(Validators.minLength(1)),
      }),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.issues.some((i) => i.path.includes("name"))).toBe(true);
    }
  });
});

describe("body decoder content-type validation", () => {
  test("decodeJsonBody returns 415 when Content-Type does not match declared", async () => {
    const request = new Request("http://localhost/items", {
      method: "POST",
      body: "name=Alice",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    const result = await decodeJsonBody(
      request,
      Decoders.object<{ name: string }>({ name: Decoders.string }),
      { contentTypes: ["application/json"] },
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(UnsupportedMediaTypeError);
      const err = result.left as UnsupportedMediaTypeError;
      expect(err.statusCode).toBe(415);
      expect(err.received).toBe("application/x-www-form-urlencoded");
      expect(err.supported).toEqual(["application/json"]);
    }
  });

  test("decodeJsonBody returns 415 when Content-Type is missing", async () => {
    const request = new Request("http://localhost/items", {
      method: "POST",
      body: JSON.stringify({ name: "Alice" }),
    });
    // Force-strip the header so node/bun's auto-injected text/plain doesn't fool the test.
    request.headers.delete("content-type");

    const result = await decodeJsonBody(
      request,
      Decoders.object<{ name: string }>({ name: Decoders.string }),
      { contentTypes: ["application/json"] },
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(UnsupportedMediaTypeError);
      const err = result.left as UnsupportedMediaTypeError;
      expect(err.statusCode).toBe(415);
      expect(err.received).toBeUndefined();
    }
  });

  test("decodeJsonBody accepts matching Content-Type with parameters", async () => {
    const request = new Request("http://localhost/items", {
      method: "POST",
      body: JSON.stringify({ name: "Alice" }),
      headers: { "content-type": "application/json; charset=utf-8" },
    });

    const result = await decodeJsonBody(
      request,
      Decoders.object<{ name: string }>({ name: Decoders.string }),
      { contentTypes: ["application/json"] },
    );

    expect(result).toEqual(Either.right({ name: "Alice" }));
  });

  test("decodeFormBody returns 415 for wrong Content-Type", async () => {
    const request = new Request("http://localhost/items", {
      method: "POST",
      body: JSON.stringify({ name: "Alice" }),
      headers: { "content-type": "application/json" },
    });

    const result = await decodeFormBody(
      request,
      Decoders.object<{ name: string }>({ name: Decoders.string }),
      { contentTypes: ["application/x-www-form-urlencoded"] },
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(UnsupportedMediaTypeError);
    }
  });

  test("decodeMultipartBody returns 415 when Content-Type does not start with multipart", async () => {
    const request = new Request("http://localhost/upload", {
      method: "POST",
      body: JSON.stringify({ name: "Alice" }),
      headers: { "content-type": "application/json" },
    });

    const result = await decodeMultipartBody(
      request,
      Decoders.object<{ name: string }>({ name: Decoders.string }),
      { contentTypes: ["multipart/form-data"] },
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(UnsupportedMediaTypeError);
    }
  });

  test("decodeMultipartBody accepts multipart/form-data with boundary", async () => {
    const formData = new FormData();
    formData.append("name", "Alice");

    const request = new Request("http://localhost/upload", {
      method: "POST",
      body: formData,
    });

    const result = await decodeMultipartBody(
      request,
      Decoders.object<{ name: string }>({ name: Decoders.string }),
      { contentTypes: ["multipart/form-data"] },
    );

    expect(result).toEqual(Either.right({ name: "Alice" }));
  });

  test("UnsupportedMediaTypeError serializes to a structured 415 response", () => {
    const err = new UnsupportedMediaTypeError("application/xml", [
      "application/json",
      "text/plain",
    ]);
    const response = err.toResponse();

    expect(response.status).toBe(415);
    expect(response.headers.get("content-type")).toBe("application/json");
  });
});

describe("content-type body dispatch", () => {
  const jsonPayload = Decoders.object<{ count: number; enabled: boolean }>({
    count: Decoders.strictInteger,
    enabled: Decoders.strictBoolean,
  });
  const formPayload = Decoders.object<{ count: number; enabled: boolean }>({
    count: Decoders.integer,
    enabled: Decoders.boolean,
  });
  const contentTypes = ["application/json", "application/x-www-form-urlencoded"];

  test("selects strict JSON and coercive form decoders at request time", async () => {
    const json = await decodeBody(
      new Request("http://localhost/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"count":2,"enabled":true}',
      }),
      { json: jsonPayload, form: formPayload },
      { contentTypes },
    );
    expect(json).toEqual(Either.right({ count: 2, enabled: true }));

    const form = await decodeBody(
      new Request("http://localhost/items", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "count=2&enabled=true",
      }),
      { json: jsonPayload, form: formPayload },
      { contentTypes },
    );
    expect(form).toEqual(Either.right({ count: 2, enabled: true }));

    const stringEncodedJson = await decodeBody(
      new Request("http://localhost/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"count":"2","enabled":"true"}',
      }),
      { json: jsonPayload, form: formPayload },
      { contentTypes },
    );
    expect(stringEncodedJson._tag).toBe("Left");
  });

  test("reports support from the decoder map when declarations and decoders disagree", async () => {
    const result = await decodeBody(
      new Request("http://localhost/items", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "hello",
      }),
      { json: jsonPayload },
      { contentTypes: ["application/json", "text/plain"] },
    );

    expect(result).toEqual(
      Either.left(new UnsupportedMediaTypeError("text/plain", ["application/json"])),
    );
  });

  test("parses text and binary bodies without routing them through JSON", async () => {
    const textResult = await decodeBody(
      new Request("http://localhost/text", {
        method: "POST",
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: "hello",
      }),
      { text: Decoders.string },
      { contentTypes: ["text/plain"] },
    );
    expect(textResult).toEqual(Either.right("hello"));

    const binaryResult = await decodeBody(
      new Request("http://localhost/binary", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([0, 127, 255]),
      }),
      { binary: Decoders.bytes },
      { contentTypes: ["application/octet-stream"] },
    );
    expect(binaryResult).toEqual(Either.right(new Uint8Array([0, 127, 255])));
  });

  test("parses resolved file bodies independently of their media type", async () => {
    const rawJson = await decodeBody(
      new Request("http://localhost/file", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: '{"still":"raw"}',
      }),
      { file: Decoders.file },
      {
        contentTypes: ["application/json"],
        allowMissingContentType: true,
      },
    );
    expect(rawJson._tag).toBe("Right");
    if (rawJson._tag === "Right") {
      expect(rawJson.right).toBeInstanceOf(File);
      expect(rawJson.right.name).toBe("");
      expect(rawJson.right.type).toBe("application/json");
      expect(await rawJson.right.text()).toBe('{"still":"raw"}');
    }

    const withoutContentType = await decodeBody(
      new Request("http://localhost/file", {
        method: "POST",
        body: new Uint8Array([1, 2]),
      }),
      { file: Decoders.file },
      {
        contentTypes: ["application/octet-stream"],
        allowMissingContentType: true,
      },
    );
    expect(withoutContentType._tag).toBe("Right");
    if (withoutContentType._tag === "Right") {
      expect(withoutContentType.right.type).toBe("");
      expect(new Uint8Array(await withoutContentType.right.arrayBuffer())).toEqual(
        new Uint8Array([1, 2]),
      );
    }

    const wrongContentType = await decodeBody(
      new Request("http://localhost/file", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "wrong",
      }),
      { file: Decoders.file },
      {
        contentTypes: ["image/png"],
        allowMissingContentType: true,
      },
    );
    expect(wrongContentType).toEqual(
      Either.left(new UnsupportedMediaTypeError("text/plain", ["image/png"])),
    );

    const malformedContentType = await decodeBody(
      new Request("http://localhost/file", {
        method: "POST",
        headers: { "content-type": "garbage" },
        body: "invalid media type",
      }),
      { file: Decoders.file },
      {
        contentTypes: ["*/*"],
        allowMissingContentType: true,
      },
    );
    expect(malformedContentType).toEqual(
      Either.left(new UnsupportedMediaTypeError("garbage", ["*/*"])),
    );
  });

  test("distinguishes missing file bodies from present zero-byte files", async () => {
    const missing = await decodeBody(
      new Request("http://localhost/file", { method: "POST" }),
      { file: Decoders.file },
      { allowMissingContentType: true },
    );
    expect(missing).toEqual(
      Either.left(new ValidationError([{ path: "$body", message: "Required body is missing." }])),
    );

    const wrongContentTypeWithoutBody = await decodeBody(
      new Request("http://localhost/file", {
        method: "POST",
        headers: { "content-type": "text/plain" },
      }),
      { file: Decoders.file },
      { contentTypes: ["image/png"] },
    );
    expect(wrongContentTypeWithoutBody).toEqual(
      Either.left(new UnsupportedMediaTypeError("text/plain", ["image/png"])),
    );

    const zeroByte = await decodeBody(
      new Request("http://localhost/file", {
        method: "POST",
        body: new Uint8Array(),
      }),
      { file: Decoders.file },
      { optional: true, allowMissingContentType: true },
    );
    expect(zeroByte._tag).toBe("Right");
    if (zeroByte._tag === "Right") {
      expect(zeroByte.right).toBeInstanceOf(File);
      expect(zeroByte.right?.size).toBe(0);
    }
  });

  test("accepts base64 JSON bytes and rejects JSON byte arrays", async () => {
    const base64 = await decodeBody(
      new Request("http://localhost/bytes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '"AQL/"',
      }),
      { json: Decoders.strictBytes },
      { contentTypes: ["application/json"] },
    );
    expect(base64).toEqual(Either.right(new Uint8Array([1, 2, 255])));

    const array = await decodeBody(
      new Request("http://localhost/bytes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "[1,2,255]",
      }),
      { json: Decoders.strictBytes },
      { contentTypes: ["application/json"] },
    );
    expect(array._tag).toBe("Left");
  });

  test("dispatches multipart bodies and coerces textual fields", async () => {
    const formData = new FormData();
    formData.append("count", "2");
    formData.append("files", new File(["one"], "one.txt"));

    const result = await decodeBody(
      new Request("http://localhost/upload", { method: "POST", body: formData }),
      {
        multipart: Decoders.object<{ count: number; files: File[] }>({
          count: Decoders.integer,
          files: Decoders.oneOrMany(Decoders.file),
        }),
      },
      { contentTypes: ["multipart/form-data"] },
    );

    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right.count).toBe(2);
      expect(result.right.files.map((file) => file.name)).toEqual(["one.txt"]);
    }
  });

  test("parses full-range int64 and uint64 JSON tokens without precision loss", async () => {
    const decoder = Decoders.object<{ signed: bigint; unsigned: bigint }>({
      signed: Decoders.strictBigint.validate(
        Validators.minValue(-9223372036854775808n),
        Validators.maxValue(9223372036854775807n),
      ),
      unsigned: Decoders.strictBigint.validate(
        Validators.minValue(0n),
        Validators.maxValue(18446744073709551615n),
      ),
    });
    const result = await decodeBody(
      new Request("http://localhost/integers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"signed":-9223372036854775808,"unsigned":18446744073709551615}',
      }),
      { json: decoder },
      { contentTypes: ["application/json"] },
    );
    expect(result).toEqual(
      Either.right({
        signed: -9223372036854775808n,
        unsigned: 18446744073709551615n,
      }),
    );
  });

  test("parses exact unsafe JSON integers written with decimal exponents", async () => {
    const result = await decodeBody(
      new Request("http://localhost/integers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "9.223372036854775807e18",
      }),
      { json: Decoders.strictLiteral(9223372036854775807n) },
      { contentTypes: ["application/json"] },
    );

    expect(result).toEqual(Either.right(9223372036854775807n));
  });

  test("rejects JSON integer tokens wider than uint64 before decoding", async () => {
    for (const token of [`1${"0".repeat(20)}`, "9".repeat(100_000)]) {
      const result = await decodeBody(
        new Request("http://localhost/integers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: token,
        }),
        { json: Decoders.unknown },
        { contentTypes: ["application/json"] },
      );

      expect(result).toEqual(
        Either.left(
          new ValidationError([{ path: "$body", message: "Body must contain valid JSON." }]),
        ),
      );
    }
  });

  test("rejects string-encoded and out-of-range 64-bit JSON integers", async () => {
    const uint64 = Decoders.strictBigint.validate(
      Validators.minValue(0n),
      Validators.maxValue(18446744073709551615n),
    );
    const fromString = await decodeBody(
      new Request("http://localhost/integers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '"18446744073709551615"',
      }),
      { json: uint64 },
      { contentTypes: ["application/json"] },
    );
    expect(fromString._tag).toBe("Left");

    const overflow = await decodeBody(
      new Request("http://localhost/integers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "18446744073709551616",
      }),
      { json: uint64 },
      { contentTypes: ["application/json"] },
    );
    expect(overflow._tag).toBe("Left");
  });

  test("an absent optional body succeeds before Content-Type validation", async () => {
    const request = new Request("http://localhost/items", { method: "POST" });
    const result = await decodeBody(
      request,
      { json: jsonPayload },
      { contentTypes: ["application/json"], optional: true },
    );
    expect(result).toEqual(Either.right(undefined));
  });

  test("an empty streaming optional body is absent before Content-Type validation", async () => {
    const request = new Request("http://localhost/items", {
      method: "POST",
      body: new Uint8Array(),
    });
    expect(request.body).not.toBeNull();

    const result = await decodeBody(
      request,
      { json: jsonPayload },
      { contentTypes: ["application/json"], optional: true },
    );

    expect(result).toEqual(Either.right(undefined));
  });

  test("a present optional body replays the probed chunk into the parser", async () => {
    const result = await decodeBody(
      new Request("http://localhost/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"count":2,"enabled":true}',
      }),
      { json: jsonPayload },
      { contentTypes: ["application/json"], optional: true },
    );

    expect(result).toEqual(Either.right({ count: 2, enabled: true }));
  });

  test("optional body probing releases its reader on an early 415", async () => {
    const request = new Request("http://localhost/items", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "present",
    });

    const result = await decodeBody(
      request,
      { json: jsonPayload },
      { contentTypes: ["application/json"], optional: true },
    );

    expect(result._tag).toBe("Left");
    expect(request.body?.locked).toBe(false);
  });

  test("lossless JSON parsing preserves prototype-sensitive keys as own data", async () => {
    const result = await decodeBody(
      new Request("http://localhost/record", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"__proto__":"proto","constructor":"ctor"}',
      }),
      { json: Decoders.record(Decoders.string) },
      { contentTypes: ["application/json"] },
    );
    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(Object.getPrototypeOf(result.right)).toBe(Object.prototype);
      expect(result.right["__proto__"]).toBe("proto");
      expect(result.right.constructor).toBe("ctor");
    }
  });
});

describe("strict JSON-mode decoders", () => {
  test("Decoders.strictLiteral matches exact value, no string coercion", () => {
    expect(Decoders.strictLiteral(5).decode(5)).toEqual(succeed(5));
    expect(Decoders.strictLiteral("x").decode("x")).toEqual(succeed("x"));
    expect(Decoders.strictLiteral(true).decode(true)).toEqual(succeed(true));
    expect(Decoders.strictLiteral(null).decode(null)).toEqual(succeed(null));
    expect(Decoders.strictLiteral(9223372036854775807n).decode(9223372036854775807n)).toEqual(
      succeed(9223372036854775807n),
    );
  });

  test("Decoders.strictLiteral rejects string-encoded values", () => {
    // These all pass with Decoders.literal (text mode) but fail with strict
    expectLeftIssues(Decoders.strictLiteral(5).decode("5"), [
      { path: "", message: "Expected literal 5." },
    ]);
    expectLeftIssues(Decoders.strictLiteral(true).decode("true"), [
      { path: "", message: "Expected literal true." },
    ]);
    expectLeftIssues(Decoders.strictLiteral(null).decode("null"), [
      { path: "", message: "Expected literal null." },
    ]);
    expectLeftIssues(Decoders.strictLiteral(9223372036854775807n).decode("9223372036854775807"), [
      { path: "", message: "Expected literal 9223372036854775807n." },
    ]);
  });

  test("Decoders.strictNullable accepts null, rejects string null", () => {
    const decoder = Decoders.strictNullable(Decoders.number);
    expect(decoder.decode(null)).toEqual(succeed(null));
    expect(decoder.decode(42)).toEqual(succeed(42));
    // "null" string should NOT decode as null in JSON mode
    expectLeftIssues(decoder.decode("null"), [{ path: "", message: "Expected a finite number." }]);
  });
});

describe("prefixIssues", () => {
  test("prefixes all issue paths in a Left", () => {
    const left = fail("", "bad");
    const prefixed = prefixIssues(left, "$body");
    expect(prefixed._tag).toBe("Left");
    if (prefixed._tag === "Left") {
      expect(prefixed.left).toEqual([{ path: "$body", message: "bad" }]);
    }
  });

  test("concatenates nested paths", () => {
    const left: ReturnType<typeof fail> = Either.left([
      { path: ".name", message: "required" },
      { path: "[0]", message: "bad item" },
    ]);
    const prefixed = prefixIssues(left, "$body");
    if (prefixed._tag === "Left") {
      expect(prefixed.left).toEqual([
        { path: "$body.name", message: "required" },
        { path: "$body[0]", message: "bad item" },
      ]);
    }
  });

  test("identity on Right", () => {
    const right = succeed(42);
    expect(prefixIssues(right, "$body")).toEqual(succeed(42));
  });
});

describe("toValidationResult", () => {
  test("converts issue array Left to ValidationError Left with prefix", () => {
    const decoderResult = fail(".name", "required");
    const result = toValidationResult(decoderResult, "$body");
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ValidationError);
      expect(result.left.issues).toEqual([{ path: "$body.name", message: "required" }]);
    }
  });

  test("passes Right through unchanged", () => {
    const decoderResult = succeed(42);
    const result = toValidationResult(decoderResult, "$body");
    expect(result).toEqual(Either.right(42));
  });
});

describe("isRight", () => {
  test("narrows Right branch", () => {
    const r = Either.right(42);
    expect(isRight(r)).toBe(true);
    if (isRight(r)) {
      expect(r.right).toBe(42);
    }
  });

  test("rejects Left branch", () => {
    expect(isRight(Either.left("err"))).toBe(false);
  });
});
