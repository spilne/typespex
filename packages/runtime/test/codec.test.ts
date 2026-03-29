import { describe, expect, test } from "bun:test";
import {
  Either,
  ValidationError,
  arrayCodec,
  bigintCodec,
  booleanCodec,
  bytesCodec,
  decode,
  decodeJsonBodyOrThrow,
  decodeJsonBody,
  decodeOptional,
  decodeOptionalOrThrow,
  decodeOrThrow,
  decodeRequired,
  decodeRequiredOrThrow,
  discriminatedCodec,
  fail,
  isRight,
  lazyCodec,
  literalCodec,
  mapCodec,
  nullableCodec,
  numberCodec,
  objectCodec,
  optional,
  prefixIssues,
  recordCodec,
  refineCodec,
  strictArrayCodec,
  strictLiteralCodec,
  strictNullableCodec,
  stringCodec,
  succeed,
  toValidationResult,
  traverseEither,
  tupleCodec,
  unionCodec,
  unknownCodec,
} from "../src/server.js";

/** Assert a Left with expected issues. Codec.decode returns issue arrays directly. */
function expectLeftIssues(
  decoded: ReturnType<typeof stringCodec.decode>,
  issues: readonly { path: string; message: string }[],
): void {
  expect(decoded._tag).toBe("Left");
  if (decoded._tag === "Left") {
    expect(decoded.left).toEqual(issues);
  }
}

describe("http codec - primitives", () => {
  test("Either.getOrElse", () => {
    expect(Either.getOrElse(Either.right(42), 0)).toBe(42);
    expect(Either.getOrElse(Either.left("nope"), 0)).toBe(0);

    let evaluated = 0;
    expect(Either.getOrElseEval(Either.left("nope"), () => {
      evaluated += 1;
      return 7;
    })).toBe(7);
    expect(evaluated).toBe(1);

    expect(Either.getOrElseEval(Either.right(1), () => {
      evaluated += 1;
      return 9;
    })).toBe(1);
    expect(evaluated).toBe(1);
  });

  test("Either.getOrElseThrow", () => {
    expect(Either.getOrElseThrow(Either.right(42))).toBe(42);

    expect(() => Either.getOrElseThrow(Either.left(new Error("left-boom")))).toThrow("left-boom");
  });

  test("Either.fold", () => {
    expect(Either.fold(Either.right(42), () => "left", (n) => `right:${n}`)).toBe("right:42");
    expect(Either.fold(Either.left("err"), (e) => `left:${e}`, () => "right")).toBe("left:err");
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

  test("stringCodec", () => {
    expect(stringCodec.decode("ok")).toEqual(Either.right("ok"));
    expectLeftIssues(
      stringCodec.decode(42),
      [{ path: "", message: "Expected a string." }],
    );
  });

  test("numberCodec", () => {
    expect(numberCodec.decode(42)).toEqual(Either.right(42));
    expect(numberCodec.decode("42.5")).toEqual(Either.right(42.5));
    expect(numberCodec.decode(0)).toEqual(Either.right(0));
    expect(numberCodec.decode(-3.14)).toEqual(Either.right(-3.14));
    expectLeftIssues(
      numberCodec.decode("Infinity"),
      [{ path: "", message: "Expected a finite number." }],
    );
    expectLeftIssues(
      numberCodec.decode(Infinity),
      [{ path: "", message: "Expected a finite number." }],
    );
    expectLeftIssues(
      numberCodec.decode(-Infinity),
      [{ path: "", message: "Expected a finite number." }],
    );
    expectLeftIssues(
      numberCodec.decode("NaN"),
      [{ path: "", message: "Expected a finite number." }],
    );
  });

  test("bigintCodec", () => {
    expect(bigintCodec.decode(42n)).toEqual(Either.right(42n));
    expect(bigintCodec.decode(42)).toEqual(Either.right(42n));
    expect(bigintCodec.decode("42")).toEqual(Either.right(42n));
    expectLeftIssues(
      bigintCodec.decode("42.1"),
      [{ path: "", message: "Expected a valid integer." }],
    );
  });

  test("booleanCodec", () => {
    expect(booleanCodec.decode(true)).toEqual(Either.right(true));
    expect(booleanCodec.decode("true")).toEqual(Either.right(true));
    expect(booleanCodec.decode("false")).toEqual(Either.right(false));
    expectLeftIssues(
      booleanCodec.decode("TRUE"),
      [{ path: "", message: 'Expected "true" or "false".' }],
    );
  });

  test("bytesCodec", () => {
    expect(bytesCodec.decode(new Uint8Array([1, 2, 3]))).toEqual(
      Either.right(new Uint8Array([1, 2, 3])),
    );

    const fromBase64 = bytesCodec.decode("AQID");
    expect(fromBase64._tag).toBe("Right");
    if (fromBase64._tag === "Right") {
      expect([...fromBase64.right]).toEqual([1, 2, 3]);
    }

    expect(bytesCodec.decode([0, 255])).toEqual(Either.right(new Uint8Array([0, 255])));
    expectLeftIssues(
      bytesCodec.decode([0, 999]),
      [{ path: "[1]", message: "Expected a byte value between 0 and 255." }],
    );
    expectLeftIssues(
      bytesCodec.decode({ nope: true }),
      [{ path: "", message: "Expected a base64 string or byte array." }],
    );
  });

  test("unknownCodec", () => {
    const value = { any: ["shape"] };
    expect(unknownCodec.decode(value)).toEqual(Either.right(value));
  });
});

describe("http codec - combinators", () => {
  test("literalCodec", () => {
    expect(literalCodec("x").decode("x")).toEqual(Either.right("x"));
    expect(literalCodec(5).decode("5")).toEqual(Either.right(5));
    expect(literalCodec(true).decode("true")).toEqual(Either.right(true));
    expect(literalCodec(null).decode("null")).toEqual(Either.right(null));
    expectLeftIssues(
      literalCodec("x").decode("y"),
      [{ path: "", message: 'Expected literal "x".' }],
    );
  });

  test("arrayCodec supports array input and text singleton input", () => {
    expect(arrayCodec(numberCodec).decode([1, "2"])).toEqual(Either.right([1, 2]));
    expect(arrayCodec(numberCodec).decode("3")).toEqual(Either.right([3]));
    expectLeftIssues(
      arrayCodec(numberCodec).decode({ nope: true }),
      [{ path: "", message: "Expected an array." }],
    );
    expectLeftIssues(
      arrayCodec(numberCodec).decode(["1", "bad"]),
      [{ path: "[1]", message: "Expected a finite number." }],
    );
  });

  test("strictArrayCodec rejects non-array inputs", () => {
    expect(strictArrayCodec(numberCodec).decode([1, "2"])).toEqual(Either.right([1, 2]));
    // Unlike arrayCodec, strictArrayCodec rejects lone strings
    expectLeftIssues(
      strictArrayCodec(numberCodec).decode("3"),
      [{ path: "", message: "Expected an array." }],
    );
    expectLeftIssues(
      strictArrayCodec(numberCodec).decode({ nope: true }),
      [{ path: "", message: "Expected an array." }],
    );
    expectLeftIssues(
      strictArrayCodec(numberCodec).decode(["1", "bad"]),
      [{ path: "[1]", message: "Expected a finite number." }],
    );
  });

  test("tupleCodec validates length and item codecs", () => {
    const codec = tupleCodec<[string, number]>([stringCodec, numberCodec]);
    expect(codec.decode(["a", "1"])).toEqual(Either.right(["a", 1]));
    expectLeftIssues(
      codec.decode(["a"]),
      [{ path: "", message: "Expected a tuple of length 2." }],
    );
    expectLeftIssues(
      codec.decode(["a", "x"]),
      [{ path: "[1]", message: "Expected a finite number." }],
    );
  });

  test("recordCodec", () => {
    const codec = recordCodec(numberCodec);
    expect(codec.decode({ a: "1", b: 2 })).toEqual(Either.right({ a: 1, b: 2 }));
    expectLeftIssues(
      codec.decode([]),
      [{ path: "", message: "Expected an object." }],
    );
    expectLeftIssues(
      codec.decode({ a: "bad" }),
      [{ path: ".a", message: "Expected a finite number." }],
    );
  });

  test("objectCodec required/optional/unknown fields", () => {
    const codec = objectCodec<{
      name: string;
      age?: number;
    }>({
      name: stringCodec,
      age: optional(numberCodec),
    });

    expect(codec.decode({ name: "ok" })).toEqual(Either.right({ name: "ok" }));
    expect(codec.decode({ name: "ok", age: "2" })).toEqual(Either.right({ name: "ok", age: 2 }));

    expectLeftIssues(
      codec.decode({ age: 2 }),
      [{ path: ".name", message: "Expected a string." }],
    );

    expectLeftIssues(
      codec.decode({ name: "ok", extra: true }),
      [{ path: ".extra", message: "Unexpected field." }],
    );

    const allowUnknown = objectCodec<{ name: string }>(
      { name: stringCodec },
      { allowUnknown: true },
    );
    expect(allowUnknown.decode({ name: "ok", extra: true })).toEqual(
      Either.right({ name: "ok" }),
    );
  });

  test("unionCodec and nullableCodec", () => {
    const union = unionCodec<string | number>([stringCodec, numberCodec]);
    expect(union.decode("x")).toEqual(Either.right("x"));
    expect(union.decode(2)).toEqual(Either.right(2));
    expectLeftIssues(
      union.decode({}),
      [{ path: "", message: "Value did not match any allowed variant." }],
    );

    const nullable = nullableCodec(numberCodec);
    expect(nullable.decode(null)).toEqual(Either.right(null));
    expect(nullable.decode("null")).toEqual(Either.right(null));
    expect(nullable.decode("2")).toEqual(Either.right(2));
  });

  test("lazyCodec resolves once and delegates decoding", () => {
    let resolved = 0;
    const lazy = lazyCodec(() => {
      resolved += 1;
      return unionCodec<number | null>([numberCodec, literalCodec(null)]);
    });

    expect(lazy.decode("2")).toEqual(Either.right(2));
    expect(lazy.decode(null)).toEqual(Either.right(null));
    expect(resolved).toBe(1);
  });

  test("discriminatedCodec dispatches by tag field", () => {
    const catCodec = objectCodec<{ type: "cat"; lives: number }>({
      type: literalCodec("cat"),
      lives: numberCodec,
    });
    const dogCodec = objectCodec<{ type: "dog"; breed: string }>({
      type: literalCodec("dog"),
      breed: stringCodec,
    });

    const animalCodec = discriminatedCodec<{ type: "cat"; lives: number } | { type: "dog"; breed: string }>(
      "type",
      { cat: catCodec, dog: dogCodec },
    );

    expect(animalCodec.decode({ type: "cat", lives: 9 })).toEqual(
      Either.right({ type: "cat", lives: 9 }),
    );
    expect(animalCodec.decode({ type: "dog", breed: "lab" })).toEqual(
      Either.right({ type: "dog", breed: "lab" }),
    );
    expectLeftIssues(
      animalCodec.decode({ type: "fish" }),
      [{ path: ".type", message: 'Unknown discriminator value: "fish".' }],
    );
    expectLeftIssues(
      animalCodec.decode("not-object"),
      [{ path: "", message: "Expected an object." }],
    );
  });

  test("discriminatedCodec handles number discriminator values", () => {
    const v1Codec = objectCodec<{ version: 1; data: string }>({
      version: literalCodec(1),
      data: stringCodec,
    });
    const v2Codec = objectCodec<{ version: 2; items: number[] }>({
      version: literalCodec(2),
      items: arrayCodec(numberCodec),
    });

    const codec = discriminatedCodec<
      { version: 1; data: string } | { version: 2; items: number[] }
    >("version", { "1": v1Codec, "2": v2Codec });

    expect(codec.decode({ version: 1, data: "hello" })).toEqual(
      Either.right({ version: 1, data: "hello" }),
    );
    expect(codec.decode({ version: 2, items: [1, 2] })).toEqual(
      Either.right({ version: 2, items: [1, 2] }),
    );
    expectLeftIssues(
      codec.decode({ version: 3 }),
      [{ path: ".version", message: "Unknown discriminator value: 3." }],
    );
  });

  test("nested object validation reports precise relative paths", () => {
    const codec = objectCodec<{
      name: string;
      tag?: "cat" | "dog";
      scores: number[];
    }>({
      name: stringCodec,
      tag: optional(unionCodec<"cat" | "dog">([literalCodec("cat"), literalCodec("dog")])),
      scores: arrayCodec(numberCodec),
    });

    const decoded = codec.decode({
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
    const codec = objectCodec<{ name: string; scores: number[] }>({
      name: stringCodec,
      scores: arrayCodec(numberCodec),
    });

    const result = decode(codec, { scores: [1, "bad"] }, "$");
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.issues).toEqual([
        { path: "$.name", message: "Expected a string." },
        { path: "$.scores[1]", message: "Expected a finite number." },
      ]);
    }
  });
});

describe("http codec - transformers", () => {
  test("mapCodec transforms decoded value", () => {
    const trimmed = mapCodec(stringCodec, (s) => s.trim());
    expect(trimmed.decode("  hello  ")).toEqual(Either.right("hello"));
    expectLeftIssues(
      trimmed.decode(42),
      [{ path: "", message: "Expected a string." }],
    );
  });

  test("refineCodec adds validation constraint", () => {
    const positive = refineCodec(numberCodec, (n) => n > 0, "Must be positive.");
    expect(positive.decode(5)).toEqual(Either.right(5));
    expect(positive.decode("3")).toEqual(Either.right(3));
    expectLeftIssues(
      positive.decode(-1),
      [{ path: "", message: "Must be positive." }],
    );

    const maxLen = refineCodec(stringCodec, (s) => s.length <= 5, (s) => `Too long: ${s.length} > 5`);
    expectLeftIssues(
      maxLen.decode("toolong"),
      [{ path: "", message: "Too long: 7 > 5" }],
    );
  });
});

describe("http codec - exported building blocks", () => {
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

describe("http codec - throw adapters", () => {
  test("decodeOrThrow", () => {
    expect(decodeOrThrow(numberCodec, "12", "$query.limit")).toBe(12);
    expect(() => decodeOrThrow(numberCodec, "bad", "$query.limit")).toThrow(ValidationError);
  });

  test("decodeRequiredOrThrow", () => {
    expect(decodeRequiredOrThrow(stringCodec, "x", "$path.id")).toBe("x");
    expect(() => decodeRequiredOrThrow(stringCodec, undefined, "$path.id")).toThrow(ValidationError);
  });

  test("decodeRequired", () => {
    expect(decodeRequired(stringCodec, "x")).toEqual(Either.right("x"));
    const decoded = decodeRequired(stringCodec, undefined);
    expect(decoded._tag).toBe("Left");
    if (decoded._tag === "Left") {
      expect(decoded.left).toEqual([
        { path: "", message: "Required value is missing." },
      ]);
    }
  });

  test("decodeOptionalOrThrow", () => {
    expect(decodeOptionalOrThrow(stringCodec, undefined, "$query.q")).toBeUndefined();
    expect(decodeOptionalOrThrow(stringCodec, "x", "$query.q")).toBe("x");
    expect(() => decodeOptionalOrThrow(numberCodec, "bad", "$query.limit")).toThrow(ValidationError);
  });

  test("decodeOptional", () => {
    expect(decodeOptional(stringCodec, undefined)).toEqual(Either.right(undefined));
    expect(decodeOptional(stringCodec, "x")).toEqual(Either.right("x"));
  });

  test("decodeJsonBodyOrThrow", async () => {
    const okRequest = new Request("http://localhost/test", {
      method: "POST",
      body: JSON.stringify({ id: "42" }),
      headers: { "content-type": "application/json" },
    });
    const value = await decodeJsonBodyOrThrow(
      okRequest,
      objectCodec<{ id: string }>({ id: stringCodec }),
      "$body",
    );
    expect(value).toEqual({ id: "42" });

    const invalidJsonRequest = new Request("http://localhost/test", {
      method: "POST",
      body: "{not-json",
      headers: { "content-type": "application/json" },
    });
    await expect(
      decodeJsonBodyOrThrow(invalidJsonRequest, objectCodec({}), "$body"),
    ).rejects.toBeInstanceOf(ValidationError);

    const invalidShapeRequest = new Request("http://localhost/test", {
      method: "POST",
      body: JSON.stringify({ id: 42 }),
      headers: { "content-type": "application/json" },
    });
    await expect(
      decodeJsonBodyOrThrow(
        invalidShapeRequest,
        objectCodec<{ id: string }>({ id: stringCodec }),
        "$body",
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
      await decodeJsonBody(
        okRequest,
        objectCodec<{ id: string }>({ id: stringCodec }),
        "$body",
      ),
    ).toEqual(Either.right({ id: "42" }));

    const invalidJsonRequest = new Request("http://localhost/test", {
      method: "POST",
      body: "{not-json",
      headers: { "content-type": "application/json" },
    });
    const decoded = await decodeJsonBody(invalidJsonRequest, objectCodec({}), "$body");
    expect(decoded._tag).toBe("Left");
    if (decoded._tag === "Left") {
      expect(decoded.left.issues).toEqual([
        { path: "$body", message: "Body must contain valid JSON." },
      ]);
    }
  });
});

describe("strict JSON-mode codecs", () => {
  test("strictLiteralCodec matches exact value, no string coercion", () => {
    expect(strictLiteralCodec(5).decode(5)).toEqual(succeed(5));
    expect(strictLiteralCodec("x").decode("x")).toEqual(succeed("x"));
    expect(strictLiteralCodec(true).decode(true)).toEqual(succeed(true));
    expect(strictLiteralCodec(null).decode(null)).toEqual(succeed(null));
  });

  test("strictLiteralCodec rejects string-encoded values", () => {
    // These all pass with literalCodec (text mode) but fail with strict
    expectLeftIssues(strictLiteralCodec(5).decode("5"), [{ path: "", message: "Expected literal 5." }]);
    expectLeftIssues(strictLiteralCodec(true).decode("true"), [{ path: "", message: "Expected literal true." }]);
    expectLeftIssues(strictLiteralCodec(null).decode("null"), [{ path: "", message: "Expected literal null." }]);
  });

  test("strictNullableCodec accepts null, rejects string null", () => {
    const codec = strictNullableCodec(numberCodec);
    expect(codec.decode(null)).toEqual(succeed(null));
    expect(codec.decode(42)).toEqual(succeed(42));
    // "null" string should NOT decode as null in JSON mode
    expectLeftIssues(codec.decode("null"), [{ path: "", message: "Expected a finite number." }]);
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
    const codecResult = fail(".name", "required");
    const result = toValidationResult(codecResult, "$body");
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ValidationError);
      expect(result.left.issues).toEqual([{ path: "$body.name", message: "required" }]);
    }
  });

  test("passes Right through unchanged", () => {
    const codecResult = succeed(42);
    const result = toValidationResult(codecResult, "$body");
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
