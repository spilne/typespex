import { describe, expect, test } from "bun:test";
import {
  Decoders,
  Either,
  UnsupportedMediaTypeError,
  Validators,
  ValidationError,
  decode,
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

  test("Decoders.string", () => {
    expect(Decoders.string.decode("ok")).toEqual(Either.right("ok"));
    expectLeftIssues(
      Decoders.string.decode(42),
      [{ path: "", message: "Expected a string." }],
    );
  });

  test("Decoders.number", () => {
    expect(Decoders.number.decode(42)).toEqual(Either.right(42));
    expect(Decoders.number.decode("42.5")).toEqual(Either.right(42.5));
    expect(Decoders.number.decode(0)).toEqual(Either.right(0));
    expect(Decoders.number.decode(-3.14)).toEqual(Either.right(-3.14));
    expectLeftIssues(
      Decoders.number.decode("Infinity"),
      [{ path: "", message: "Expected a finite number." }],
    );
    expectLeftIssues(
      Decoders.number.decode(Infinity),
      [{ path: "", message: "Expected a finite number." }],
    );
    expectLeftIssues(
      Decoders.number.decode(-Infinity),
      [{ path: "", message: "Expected a finite number." }],
    );
    expectLeftIssues(
      Decoders.number.decode("NaN"),
      [{ path: "", message: "Expected a finite number." }],
    );
  });

  test("Decoders.bigint", () => {
    expect(Decoders.bigint.decode(42n)).toEqual(Either.right(42n));
    expect(Decoders.bigint.decode(42)).toEqual(Either.right(42n));
    expect(Decoders.bigint.decode("42")).toEqual(Either.right(42n));
    expectLeftIssues(
      Decoders.bigint.decode("42.1"),
      [{ path: "", message: "Expected a valid integer." }],
    );
  });

  test("Decoders.boolean", () => {
    expect(Decoders.boolean.decode(true)).toEqual(Either.right(true));
    expect(Decoders.boolean.decode("true")).toEqual(Either.right(true));
    expect(Decoders.boolean.decode("false")).toEqual(Either.right(false));
    expectLeftIssues(
      Decoders.boolean.decode("TRUE"),
      [{ path: "", message: 'Expected "true" or "false".' }],
    );
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
    expectLeftIssues(
      Decoders.bytes.decode([0, 999]),
      [{ path: "[1]", message: "Expected a byte value between 0 and 255." }],
    );
    expectLeftIssues(
      Decoders.bytes.decode({ nope: true }),
      [{ path: "", message: "Expected a base64 string or byte array." }],
    );
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
    expectLeftIssues(
      Decoders.literal("x").decode("y"),
      [{ path: "", message: 'Expected literal "x".' }],
    );
  });

  test("Decoders.array supports array input and text singleton input", () => {
    expect(Decoders.array(Decoders.number).decode([1, "2"])).toEqual(Either.right([1, 2]));
    expect(Decoders.array(Decoders.number).decode("3")).toEqual(Either.right([3]));
    expectLeftIssues(
      Decoders.array(Decoders.number).decode({ nope: true }),
      [{ path: "", message: "Expected an array." }],
    );
    expectLeftIssues(
      Decoders.array(Decoders.number).decode(["1", "bad"]),
      [{ path: "[1]", message: "Expected a finite number." }],
    );
  });

  test("Decoders.strictArray rejects non-array inputs", () => {
    expect(Decoders.strictArray(Decoders.number).decode([1, "2"])).toEqual(Either.right([1, 2]));
    // Unlike Decoders.array, Decoders.strictArray rejects lone strings
    expectLeftIssues(
      Decoders.strictArray(Decoders.number).decode("3"),
      [{ path: "", message: "Expected an array." }],
    );
    expectLeftIssues(
      Decoders.strictArray(Decoders.number).decode({ nope: true }),
      [{ path: "", message: "Expected an array." }],
    );
    expectLeftIssues(
      Decoders.strictArray(Decoders.number).decode(["1", "bad"]),
      [{ path: "[1]", message: "Expected a finite number." }],
    );
  });

  test("Decoders.tuple validates length and item decoders", () => {
    const decoder = Decoders.tuple<[string, number]>([Decoders.string, Decoders.number]);
    expect(decoder.decode(["a", "1"])).toEqual(Either.right(["a", 1]));
    expectLeftIssues(
      decoder.decode(["a"]),
      [{ path: "", message: "Expected a tuple of length 2." }],
    );
    expectLeftIssues(
      decoder.decode(["a", "x"]),
      [{ path: "[1]", message: "Expected a finite number." }],
    );
  });

  test("Decoders.record", () => {
    const decoder = Decoders.record(Decoders.number);
    expect(decoder.decode({ a: "1", b: 2 })).toEqual(Either.right({ a: 1, b: 2 }));
    expectLeftIssues(
      decoder.decode([]),
      [{ path: "", message: "Expected an object." }],
    );
    expectLeftIssues(
      decoder.decode({ a: "bad" }),
      [{ path: ".a", message: "Expected a finite number." }],
    );
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

    expectLeftIssues(
      decoder.decode({ age: 2 }),
      [{ path: ".name", message: "Expected a string." }],
    );

    expectLeftIssues(
      decoder.decode({ name: "ok", extra: true }),
      [{ path: ".extra", message: "Unexpected field." }],
    );

    const allowUnknown = Decoders.object<{ name: string }>(
      { name: Decoders.string },
      { allowUnknown: true },
    );
    expect(allowUnknown.decode({ name: "ok", extra: true })).toEqual(
      Either.right({ name: "ok" }),
    );
  });

  test("Decoders.union and Decoders.nullable", () => {
    const union = Decoders.union<string | number>([Decoders.string, Decoders.number]);
    expect(union.decode("x")).toEqual(Either.right("x"));
    expect(union.decode(2)).toEqual(Either.right(2));
    expectLeftIssues(
      union.decode({}),
      [{ path: "", message: "Value did not match any allowed variant." }],
    );

    const nullable = Decoders.nullable(Decoders.number);
    expect(nullable.decode(null)).toEqual(Either.right(null));
    expect(nullable.decode("null")).toEqual(Either.right(null));
    expect(nullable.decode("2")).toEqual(Either.right(2));
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

    const animalDecoder = Decoders.discriminated<{ type: "cat"; lives: number } | { type: "dog"; breed: string }>(
      "type",
      { cat: catDecoder, dog: dogDecoder },
    );

    expect(animalDecoder.decode({ type: "cat", lives: 9 })).toEqual(
      Either.right({ type: "cat", lives: 9 }),
    );
    expect(animalDecoder.decode({ type: "dog", breed: "lab" })).toEqual(
      Either.right({ type: "dog", breed: "lab" }),
    );
    expectLeftIssues(
      animalDecoder.decode({ type: "fish" }),
      [{ path: ".type", message: 'Unknown discriminator value: "fish".' }],
    );
    expectLeftIssues(
      animalDecoder.decode("not-object"),
      [{ path: "", message: "Expected an object." }],
    );
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
    expectLeftIssues(
      decoder.decode({ version: 3 }),
      [{ path: ".version", message: "Unknown discriminator value: 3." }],
    );
  });

  test("nested object validation reports precise relative paths", () => {
    const decoder = Decoders.object<{
      name: string;
      tag?: "cat" | "dog";
      scores: number[];
    }>({
      name: Decoders.string,
      tag: Decoders.optional(Decoders.union<"cat" | "dog">([Decoders.literal("cat"), Decoders.literal("dog")])),
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
    expectLeftIssues(
      trimmed.decode(42),
      [{ path: "", message: "Expected a string." }],
    );
  });

  test("Decoders.refine adds validation constraint", () => {
    const positive = Decoders.refine(Decoders.number, (n) => n > 0, "Must be positive.");
    expect(positive.decode(5)).toEqual(Either.right(5));
    expect(positive.decode("3")).toEqual(Either.right(3));
    expectLeftIssues(
      positive.decode(-1),
      [{ path: "", message: "Must be positive." }],
    );

    const maxLen = Decoders.refine(Decoders.string, (s) => s.length <= 5, (s) => `Too long: ${s.length} > 5`);
    expectLeftIssues(
      maxLen.decode("toolong"),
      [{ path: "", message: "Too long: 7 > 5" }],
    );
  });

  test("Decoder.validate accumulates validator issues", () => {
    const decoder = Decoders.string.validate(
      Validators.minLength(3),
      Validators.pattern("^[a-z]+$", "Must be lower-case letters."),
    );

    expect(decoder.decode("abc")).toEqual(Either.right("abc"));
    expectLeftIssues(
      decoder.decode("A"),
      [
        { path: "", message: "Expected length greater than or equal to 3." },
        { path: "", message: "Must be lower-case letters." },
      ],
    );
  });

  test("Validators cover numeric, length, item, and pattern checks", () => {
    expect(Decoders.number.validate(Validators.minValue(1)).decode(1)).toEqual(Either.right(1));
    expectLeftIssues(
      Decoders.number.validate(Validators.minValueExclusive(1)).decode(1),
      [{ path: "", message: "Expected a value greater than 1." }],
    );
    expectLeftIssues(
      Decoders.number.validate(Validators.maxValue(5)).decode(6),
      [{ path: "", message: "Expected a value less than or equal to 5." }],
    );
    expectLeftIssues(
      Decoders.number.validate(Validators.maxValueExclusive(5)).decode(5),
      [{ path: "", message: "Expected a value less than 5." }],
    );
    expectLeftIssues(
      Decoders.array(Decoders.string).validate(Validators.minItems(2)).decode(["one"]),
      [{ path: "", message: "Expected at least 2 item(s)." }],
    );
    expectLeftIssues(
      Decoders.array(Decoders.string).validate(Validators.maxItems(1)).decode(["one", "two"]),
      [{ path: "", message: "Expected at most 1 item(s)." }],
    );
    expectLeftIssues(
      Decoders.string.validate(Validators.maxLength(2)).decode("abc"),
      [{ path: "", message: "Expected length less than or equal to 2." }],
    );
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
    expect(() => decodeRequiredOrThrow(Decoders.string, undefined, "$path.id")).toThrow(ValidationError);
  });

  test("decodeRequired", () => {
    expect(decodeRequired(Decoders.string, "x")).toEqual(Either.right("x"));
    const decoded = decodeRequired(Decoders.string, undefined);
    expect(decoded._tag).toBe("Left");
    if (decoded._tag === "Left") {
      expect(decoded.left).toEqual([
        { path: "", message: "Required value is missing." },
      ]);
    }
  });

  test("decodeOptionalOrThrow", () => {
    expect(decodeOptionalOrThrow(Decoders.string, undefined, "$query.q")).toBeUndefined();
    expect(decodeOptionalOrThrow(Decoders.string, "x", "$query.q")).toBe("x");
    expect(() => decodeOptionalOrThrow(Decoders.number, "bad", "$query.limit")).toThrow(ValidationError);
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
      await decodeJsonBody(
        okRequest,
        Decoders.object<{ id: string }>({ id: Decoders.string }),
      ),
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
    const err = new UnsupportedMediaTypeError("application/xml", ["application/json", "text/plain"]);
    const response = err.toResponse();

    expect(response.status).toBe(415);
    expect(response.headers.get("content-type")).toBe("application/json");
  });
});

describe("strict JSON-mode decoders", () => {
  test("Decoders.strictLiteral matches exact value, no string coercion", () => {
    expect(Decoders.strictLiteral(5).decode(5)).toEqual(succeed(5));
    expect(Decoders.strictLiteral("x").decode("x")).toEqual(succeed("x"));
    expect(Decoders.strictLiteral(true).decode(true)).toEqual(succeed(true));
    expect(Decoders.strictLiteral(null).decode(null)).toEqual(succeed(null));
  });

  test("Decoders.strictLiteral rejects string-encoded values", () => {
    // These all pass with Decoders.literal (text mode) but fail with strict
    expectLeftIssues(Decoders.strictLiteral(5).decode("5"), [{ path: "", message: "Expected literal 5." }]);
    expectLeftIssues(Decoders.strictLiteral(true).decode("true"), [{ path: "", message: "Expected literal true." }]);
    expectLeftIssues(Decoders.strictLiteral(null).decode("null"), [{ path: "", message: "Expected literal null." }]);
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
