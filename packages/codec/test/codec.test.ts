import { describe, expect, test } from "bun:test";
import { Temporal } from "@js-temporal/polyfill";
import { createValueCodec } from "../src/index.js";

describe("protocol-neutral value codec", () => {
  test("applies encoded names, defaults, dates, bytes, and lossless integers", async () => {
    const codec = createValueCodec<{
      count: bigint;
      createdAt: Date;
      bytes: Uint8Array;
      enabled: boolean;
    }>({
      root: {
        kind: "object",
        properties: {
          count: { wireName: "count_string", codec: { kind: "bigint-string" } },
          createdAt: {
            wireName: "created_at",
            codec: {
              kind: "date-time",
              representation: "date",
              format: "date-time",
            },
          },
          bytes: { wireName: "data", codec: { kind: "bytes", encoding: "base64" } },
          enabled: {
            wireName: "enabled",
            codec: { kind: "identity" },
            optional: true,
            hasDefault: true,
            defaultValue: true,
          },
        },
      },
    });

    const decoded = await codec.decode({
      count_string: "9007199254740993",
      created_at: "2026-08-15T12:00:00Z",
      data: "AQID",
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.count).toBe(9_007_199_254_740_993n);
    expect(decoded.value.createdAt.toISOString()).toBe("2026-08-15T12:00:00.000Z");
    expect([...decoded.value.bytes]).toEqual([1, 2, 3]);
    expect(decoded.value.enabled).toBe(true);

    const encoded = await codec.encode(decoded.value);
    expect(encoded).toEqual({
      ok: true,
      value: {
        count_string: "9007199254740993",
        created_at: "2026-08-15T12:00:00.000Z",
        data: "AQID",
        enabled: true,
      },
    });
  });

  test("supports recursive definitions without accepting prototype properties", async () => {
    const codec = createValueCodec<{ value: string; next?: unknown }>({
      root: { kind: "ref", name: "Node" },
      definitions: {
        Node: {
          kind: "object",
          properties: {
            value: { wireName: "value", codec: { kind: "identity" } },
            next: {
              wireName: "next",
              codec: { kind: "ref", name: "Node" },
              optional: true,
            },
          },
        },
      },
    });
    const decoded = await codec.decode({ value: "a", next: { value: "b" } });
    expect(decoded).toEqual({
      ok: true,
      value: { value: "a", next: { value: "b" } },
    });

    const inherited = Object.create({ value: "inherited" }) as Record<string, unknown>;
    const rejected = await codec.decode(inherited);
    expect(rejected.ok).toBe(false);
  });

  test("round-trips Web File records", async () => {
    const codec = createValueCodec<File>({ root: { kind: "file" } });
    const decoded = await codec.decode({
      name: "hello.txt",
      mediaType: "text/plain",
      data: "aGVsbG8=",
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.name).toBe("hello.txt");
    expect(await decoded.value.text()).toBe("hello");
    const encoded = await codec.encode(decoded.value);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.value).toMatchObject({ name: "hello.txt", data: "aGVsbG8=" });
    expect((encoded.value as { mediaType: string }).mediaType).toStartWith("text/plain");
  });

  test("selects transformed union branches and string-encoded primitives", async () => {
    const union = createValueCodec<string | bigint>({
      root: {
        kind: "union",
        variants: [{ kind: "primitive", type: "string" }, { kind: "bigint-string" }],
      },
    });
    expect(await union.encode(42n)).toEqual({ ok: true, value: "42" });
    expect(await union.encode("text")).toEqual({ ok: true, value: "text" });

    const primitives = createValueCodec<{ count: number; enabled: boolean }>({
      root: {
        kind: "object",
        properties: {
          count: {
            wireName: "count",
            codec: { kind: "number-string", integer: true },
          },
          enabled: { wireName: "enabled", codec: { kind: "boolean-string" } },
        },
      },
    });
    expect(await primitives.decode({ count: "12", enabled: "false" })).toEqual({
      ok: true,
      value: { count: 12, enabled: false },
    });
    expect(await primitives.encode({ count: 12, enabled: false })).toEqual({
      ok: true,
      value: { count: "12", enabled: "false" },
    });

    const safeBigint = createValueCodec<bigint>({ root: { kind: "bigint-number" } });
    expect(await safeBigint.decode(42)).toEqual({ ok: true, value: 42n });
    expect(await safeBigint.encode(42n)).toEqual({ ok: true, value: 42 });
    expect((await safeBigint.encode(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).ok).toBe(false);
  });

  test("preserves distinct Temporal representations", async () => {
    const codec = createValueCodec<{
      date: Temporal.PlainDate;
      time: Temporal.PlainTime;
      instant: Temporal.Instant;
      offset: Temporal.ZonedDateTime;
      duration: Temporal.Duration;
    }>({
      root: {
        kind: "object",
        properties: {
          date: {
            wireName: "date",
            codec: {
              kind: "date-time",
              representation: "temporal",
              format: "date",
              temporalKind: "plain-date",
            },
          },
          time: {
            wireName: "time",
            codec: {
              kind: "date-time",
              representation: "temporal",
              format: "time",
              temporalKind: "plain-time",
            },
          },
          instant: {
            wireName: "instant",
            codec: {
              kind: "date-time",
              representation: "temporal",
              format: "date-time",
              temporalKind: "instant",
            },
          },
          offset: {
            wireName: "offset",
            codec: {
              kind: "date-time",
              representation: "temporal",
              format: "date-time",
              temporalKind: "zoned-date-time",
            },
          },
          duration: {
            wireName: "duration",
            codec: {
              kind: "date-time",
              representation: "temporal",
              format: "duration",
              temporalKind: "duration",
            },
          },
        },
      },
    });
    const wire = {
      date: "2026-08-15",
      time: "12:34:56",
      instant: "2026-08-15T10:34:56Z",
      offset: "2026-08-15T12:34:56+02:00",
      duration: "PT5M",
    };
    const decoded = await codec.decode(wire);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.date).toBeInstanceOf(Temporal.PlainDate);
    expect(decoded.value.offset).toBeInstanceOf(Temporal.ZonedDateTime);
    expect(await codec.encode(decoded.value)).toEqual({ ok: true, value: wire });
  });

  test("validates primitive and string-encoded scalar transforms in both directions", async () => {
    const stringCodec = createValueCodec<string>({
      root: { kind: "primitive", type: "string" },
    });
    expect(await stringCodec.decode("value")).toEqual({ ok: true, value: "value" });
    expect((await stringCodec.decode(1)).ok).toBe(false);
    expect(await stringCodec.encode("value")).toEqual({ ok: true, value: "value" });
    expect((await stringCodec.encode(1 as never)).ok).toBe(false);

    const literalCodec = createValueCodec<"fixed">({
      root: { kind: "literal", value: "fixed" },
    });
    expect((await literalCodec.decode("other")).ok).toBe(false);
    expect(await literalCodec.decode("fixed")).toEqual({ ok: true, value: "fixed" });
    expect((await literalCodec.encode("other" as never)).ok).toBe(false);

    const bigintCodec = createValueCodec<bigint>({ root: { kind: "bigint-string" } });
    expect((await bigintCodec.decode("01")).ok).toBe(false);
    expect((await bigintCodec.encode("1" as never)).ok).toBe(false);
    const bigintLiteralCodec = createValueCodec<9_007_199_254_740_993n>({
      root: { kind: "bigint-literal-string", value: "9007199254740993" },
    });
    expect(await bigintLiteralCodec.decode("9007199254740993")).toEqual({
      ok: true,
      value: 9_007_199_254_740_993n,
    });
    expect(await bigintLiteralCodec.encode(9_007_199_254_740_993n)).toEqual({
      ok: true,
      value: "9007199254740993",
    });
    expect((await bigintLiteralCodec.decode("9007199254740994")).ok).toBe(false);
    expect((await bigintLiteralCodec.encode(9_007_199_254_740_994n as never)).ok).toBe(false);
    expect(
      (
        await createValueCodec({
          root: { kind: "bigint-literal-string", value: "invalid" },
        }).decode("invalid")
      ).ok,
    ).toBe(false);
    expect((await createValueCodec({ root: { kind: "bigint-number" } }).decode(1.5)).ok).toBe(
      false,
    );
    expect(
      (await createValueCodec({ root: { kind: "bigint-number" } }).encode(1 as never)).ok,
    ).toBe(false);

    const decimalCodec = createValueCodec<string>({ root: { kind: "decimal-string" } });
    expect(await decimalCodec.decode("12.5e2")).toEqual({ ok: true, value: "12.5e2" });
    expect((await decimalCodec.decode("NaN")).ok).toBe(false);
    expect((await decimalCodec.encode("NaN")).ok).toBe(false);

    const numberCodec = createValueCodec<number>({
      root: { kind: "number-string", integer: false },
    });
    expect(await numberCodec.decode("1.25e2")).toEqual({ ok: true, value: 125 });
    expect((await numberCodec.decode("1e999")).ok).toBe(false);
    expect((await numberCodec.decode(true)).ok).toBe(false);
    expect((await numberCodec.encode(Number.POSITIVE_INFINITY)).ok).toBe(false);

    const booleanCodec = createValueCodec<boolean>({ root: { kind: "boolean-string" } });
    expect(await booleanCodec.decode("true")).toEqual({ ok: true, value: true });
    expect((await booleanCodec.decode("yes")).ok).toBe(false);
    expect((await booleanCodec.encode("true" as never)).ok).toBe(false);

    const bytesCodec = createValueCodec<Uint8Array>({
      root: { kind: "bytes", encoding: "base64url" },
    });
    expect(await bytesCodec.decode("-_8")).toEqual({
      ok: true,
      value: new Uint8Array([251, 255]),
    });
    expect(await bytesCodec.encode(new Uint8Array([251, 255]))).toEqual({
      ok: true,
      value: "-_8",
    });
    const largeBytes = Uint8Array.from({ length: 100_000 }, (_, index) => index % 256);
    const largeEncoded = await bytesCodec.encode(largeBytes);
    expect(largeEncoded.ok).toBe(true);
    if (largeEncoded.ok) {
      expect(await bytesCodec.decode(largeEncoded.value)).toEqual({ ok: true, value: largeBytes });
    }
    expect((await bytesCodec.decode("not base64!")).ok).toBe(false);
    expect((await bytesCodec.decode(1)).ok).toBe(false);
    expect((await bytesCodec.encode("-_8" as never)).ok).toBe(false);
  });

  test("collects array and tuple issues with precise element paths", async () => {
    const arrayCodec = createValueCodec<number[]>({
      root: { kind: "array", item: { kind: "primitive", type: "number" } },
    });
    expect(await arrayCodec.decode([1, 2])).toEqual({ ok: true, value: [1, 2] });
    expect(await arrayCodec.encode([1, 2])).toEqual({ ok: true, value: [1, 2] });
    expect((await arrayCodec.decode("not-array")).ok).toBe(false);
    expect((await arrayCodec.encode("not-array" as never)).ok).toBe(false);
    expect(await arrayCodec.decode([1, "bad"])).toMatchObject({
      ok: false,
      issues: [{ path: [1] }],
    });
    expect(await arrayCodec.encode([1, "bad"] as never)).toMatchObject({
      ok: false,
      issues: [{ path: [1] }],
    });

    const tupleCodec = createValueCodec<readonly ["item", boolean]>({
      root: {
        kind: "tuple",
        items: [
          { kind: "literal", value: "item" },
          { kind: "primitive", type: "boolean" },
        ],
      },
    });
    expect(await tupleCodec.decode(["item", true])).toEqual({
      ok: true,
      value: ["item", true],
    });
    expect(await tupleCodec.encode(["item", false])).toEqual({
      ok: true,
      value: ["item", false],
    });
    expect((await tupleCodec.decode(["item"])).ok).toBe(false);
    expect((await tupleCodec.encode(["item"] as never)).ok).toBe(false);
    expect(await tupleCodec.decode(["wrong", "bad"])).toMatchObject({
      ok: false,
      issues: [{ path: [0] }, { path: [1] }],
    });
    expect(await tupleCodec.encode(["wrong", "bad"] as never)).toMatchObject({
      ok: false,
      issues: [{ path: [0] }, { path: [1] }],
    });
  });

  test("handles typed additional properties, defaults, and missing object fields", async () => {
    const codec = createValueCodec<Record<string, unknown>>({
      root: {
        kind: "object",
        properties: {
          required: {
            wireName: "required_wire",
            codec: { kind: "primitive", type: "string" },
          },
          defaulted: {
            wireName: "defaulted",
            codec: { kind: "primitive", type: "string" },
            hasDefault: true,
            defaultValue: "fallback",
          },
        },
        additionalProperties: { kind: "number-string", integer: true },
      },
    });
    expect(await codec.decode({ required_wire: "yes", count: "12" })).toEqual({
      ok: true,
      value: { required: "yes", defaulted: "fallback", count: 12 },
    });
    expect(await codec.encode({ required: "yes", count: 12 })).toEqual({
      ok: true,
      value: { required_wire: "yes", count: "12" },
    });
    expect(await codec.decode({ required_wire: "yes", required: "12" })).toMatchObject({
      ok: false,
      issues: [{ path: ["required"] }],
    });
    expect(await codec.encode({ required: "yes", required_wire: 12 })).toMatchObject({
      ok: false,
      issues: [{ path: ["required_wire"] }],
    });

    const closed = createValueCodec<Record<string, unknown>>({
      root: {
        kind: "object",
        properties: {
          required: {
            wireName: "required_wire",
            codec: { kind: "primitive", type: "string" },
          },
        },
      },
    });
    expect(await closed.decode({ required_wire: "yes", required: "ignored" })).toEqual({
      ok: true,
      value: { required: "yes" },
    });
    expect(await closed.encode({ required: "yes", required_wire: "ignored" })).toEqual({
      ok: true,
      value: { required_wire: "yes" },
    });

    const duplicateWireName = createValueCodec<Record<string, unknown>>({
      root: {
        kind: "object",
        properties: {
          first: { wireName: "same", codec: { kind: "primitive", type: "string" } },
          second: { wireName: "same", codec: { kind: "primitive", type: "string" } },
        },
      },
    });
    expect(await duplicateWireName.decode({ same: "value" })).toMatchObject({
      ok: false,
      issues: [{ path: ["same"] }],
    });
    expect(await duplicateWireName.encode({ first: "one", second: "two" })).toMatchObject({
      ok: false,
      issues: [{ path: ["same"] }],
    });
    expect((await codec.decode([])).ok).toBe(false);
    expect((await codec.encode([])).ok).toBe(false);
    expect(await codec.decode({ count: "bad" })).toMatchObject({
      ok: false,
      issues: [{ path: ["required_wire"] }, { path: ["count"] }],
    });
    expect(await codec.encode({ required: 1, count: "bad" })).toMatchObject({
      ok: false,
      issues: [{ path: ["required"] }, { path: ["count"] }],
    });
    expect((await codec.encode({})).ok).toBe(false);

    const open = createValueCodec<Record<string, unknown>>({
      root: { kind: "object", properties: {}, additionalProperties: true },
    });
    expect(await open.decode({ __extra: "value" })).toEqual({
      ok: true,
      value: { __extra: "value" },
    });
    expect(await open.encode({ __extra: "value" })).toEqual({
      ok: true,
      value: { __extra: "value" },
    });

    const badDefault = createValueCodec({
      root: {
        kind: "object",
        properties: {
          value: {
            wireName: "value",
            codec: { kind: "literal", value: "valid" },
            hasDefault: true,
            defaultValue: "invalid",
          },
        },
      },
    });
    expect((await badDefault.decode({})).ok).toBe(false);
  });

  test("reports failed unions, references, and nesting limits deterministically", async () => {
    const union = createValueCodec({
      root: {
        kind: "union",
        variants: [
          { kind: "primitive", type: "string" },
          { kind: "tuple", items: [{ kind: "literal", value: "item" }] },
        ],
      },
    });
    expect((await union.decode(false)).ok).toBe(false);
    expect((await union.encode(false)).ok).toBe(false);

    const emptyUnion = createValueCodec({ root: { kind: "union", variants: [] } });
    expect(await emptyUnion.decode("value")).toMatchObject({
      ok: false,
      issues: [{ message: "No union variant is defined." }],
    });
    expect(await emptyUnion.encode("value")).toMatchObject({
      ok: false,
      issues: [{ message: "No union variant is defined." }],
    });

    const missingReference = createValueCodec({ root: { kind: "ref", name: "Missing" } });
    expect((await missingReference.decode("value")).ok).toBe(false);
    expect((await missingReference.encode("value")).ok).toBe(false);

    const recursive = createValueCodec({
      root: { kind: "ref", name: "Loop" },
      definitions: { Loop: { kind: "ref", name: "Loop" } },
    });
    expect(await recursive.decode("value")).toMatchObject({
      ok: false,
      issues: [{ message: "Codec nesting limit exceeded." }],
    });
    expect(await recursive.encode("value")).toMatchObject({
      ok: false,
      issues: [{ message: "Codec nesting limit exceeded." }],
    });
  });

  test("rejects invalid date-time and file semantic values", async () => {
    const stringDate = createValueCodec<string>({
      root: { kind: "date-time", representation: "string", format: "date" },
    });
    expect(await stringDate.decode("2026-08-15")).toEqual({
      ok: true,
      value: "2026-08-15",
    });
    expect((await stringDate.decode(1)).ok).toBe(false);
    expect((await stringDate.encode(1 as never)).ok).toBe(false);

    const date = createValueCodec<Date>({
      root: { kind: "date-time", representation: "date", format: "date-time" },
    });
    expect((await date.decode("not-a-date")).ok).toBe(false);
    expect((await date.encode(new Date(Number.NaN))).ok).toBe(false);

    const instant = createValueCodec<Temporal.Instant>({
      root: {
        kind: "date-time",
        representation: "temporal",
        format: "date-time",
        temporalKind: "instant",
      },
    });
    expect((await instant.decode("2026-08-15T12:00:60Z")).ok).toBe(false);
    expect((await instant.decode("2026-08-15T12:00:00-00:00")).ok).toBe(false);
    expect((await instant.encode(Temporal.PlainDate.from("2026-08-15") as never)).ok).toBe(false);

    const zoned = createValueCodec<Temporal.ZonedDateTime>({
      root: {
        kind: "date-time",
        representation: "temporal",
        format: "date-time",
        temporalKind: "zoned-date-time",
      },
    });
    expect((await zoned.encode(Temporal.Instant.from("2026-08-15T12:00:00Z") as never)).ok).toBe(
      false,
    );

    const file = createValueCodec<File>({ root: { kind: "file" } });
    expect((await file.decode(null)).ok).toBe(false);
    expect((await file.decode({})).ok).toBe(false);
    expect((await file.decode({ name: "a", data: "QQ==", mediaType: 1 })).ok).toBe(false);
    expect((await file.decode({ name: "a", data: "invalid!" })).ok).toBe(false);
    expect((await file.encode({} as never)).ok).toBe(false);
  });
});
