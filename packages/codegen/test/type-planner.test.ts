import { describe, expect, test } from "bun:test";
import type { Model, Namespace, Operation, Type } from "@typespec/compiler";
import { createTestHost, createTestRunner } from "@typespec/compiler/testing";
import { HttpTestLibrary } from "@typespec/http/testing";
import {
  TypePlanner,
  isVoidType,
  type CodegenIssue,
  type TypeProjection,
} from "../src/unstable.js";

async function compile(source: string, http = false) {
  const host = await createTestHost(http ? { libraries: [HttpTestLibrary] } : undefined);
  const runner = await createTestRunner(host);
  const [, diagnostics] = await runner.compileAndDiagnose(source);
  expect(
    diagnostics
      .filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) => diagnostic.message),
  ).toEqual([]);
  return runner.program;
}

function namespace(global: Namespace, name: string): Namespace {
  const result = global.namespaces.get(name);
  if (!result) throw new Error(`Expected namespace ${name}.`);
  return result;
}

function model(container: Namespace, name: string): Model {
  const result = container.models.get(name);
  if (!result) throw new Error(`Expected model ${name}.`);
  return result;
}

function operation(container: Namespace, name: string): Operation {
  const result = container.operations.get(name);
  if (!result) throw new Error(`Expected operation ${name}.`);
  return result;
}

describe("TypePlanner", () => {
  test("plans semantic models, projected views, schemas, codecs, and defaults", async () => {
    const program = await compile(`
      @doc("A constrained identifier.")
      @minLength(2) @maxLength(12) @pattern("^[a-z]+$") @format("slug")
      scalar Slug extends string;

      @minValue(-10) @maxValue(10)
      scalar SmallId extends int64;

      @encode(string)
      scalar LargeId extends int64;

      @encode(string)
      scalar Money extends decimal;

      enum Kind { cat, dog: "hound", seven: 7 }

      union Choice {
        slug: Slug,
        kind: Kind,
        label: "fixed",
        count: 42,
        active: true,
        nil: null,
        pair: [string, int32]
      }

      @summary("A recursive node.")
      model Node {
        value: Slug;
        next?: Node;
      }

      model StringMap extends Record<Slug> {
        known: Slug;
      }

      #deprecated "Use NewEverything."
      @doc("Exercises the complete semantic and JSON wire planner.")
      model Everything {
        @encodedName("application/json", "wire_name")
        @doc("A renamed field.")
        name: Slug = "alpha";

        secret: string;
        optional?: string;
        enabled: boolean = true;
        absent: null = null;
        strings: string[] = #["one", "two"];
        object: { label: string } = #{ label: "value" };
        kind: Kind = Kind.cat;
        small: SmallId = 5;
        large: LargeId = 9007199254740993;
        money: Money = 12.50;
        choice: Choice;
        pair: [string, int32];
        node: Node;
        dictionary: StringMap;
        text: string;
        link: url;
        truth: boolean;
        data: bytes;
        date: plainDate;
        time: plainTime;
        instant: utcDateTime;
        zoned: offsetDateTime;
        elapsed: duration;
        i8: int8;
        u8: uint8;
        i16: int16;
        u16: uint16;
        i32: int32;
        u32: uint32;
        safe: safeint;
        f32: float32;
        f64: float64;
        f: float;

        @minItems(1) @maxItems(3)
        tags: string[];

        @minValueExclusive(0) @maxValueExclusive(1)
        ratio: float64;
      }

      namespace Left { model Duplicate { left: string; } }
      namespace Right { model Duplicate { right: string; } }

      namespace Api {
        op run(input: Everything): Choice;
        op empty(): void;
        op impossible(): never;
      }
    `);
    const global = program.getGlobalNamespaceType();
    const everything = model(global, "Everything");
    const api = namespace(global, "Api");
    const left = model(namespace(global, "Left"), "Duplicate");
    const right = model(namespace(global, "Right"), "Duplicate");
    const run = operation(api, "run");
    const issues: CodegenIssue[] = [];
    const planner = new TypePlanner(program, {
      datetimeMode: "temporal",
      onIssue: (issue) => issues.push(issue),
    });
    const roots: Type[] = [everything, run.returnType, left, right];
    planner.prepare(roots);

    expect(planner.declarations.length).toBeGreaterThan(8);
    expect(planner.getGeneratedName(left)).toBe("Duplicate");
    expect(planner.getGeneratedName(right)).toBe("RightDuplicate");
    expect(() => planner.getGeneratedName(model(global, "StringMap"))).not.toThrow();
    expect(planner.typeToTs(everything)).toBe("Everything");
    expect(planner.typeToTs(run.parameters)).toContain("input: Everything");
    expect(planner.typeToTs(run.returnType)).toBe("Choice");
    expect(planner.typeToTs(operation(api, "empty").returnType)).toBe("void");
    expect(planner.typeToTs(operation(api, "impossible").returnType)).toBe("never");
    expect(isVoidType(operation(api, "empty").returnType)).toBe(true);
    expect(isVoidType(run.returnType)).toBe(false);

    const projection: TypeProjection = {
      key: "input",
      propertyFilter: (property) => property.name !== "secret",
    };
    const wire = planner.createWirePlan(everything, { projection });
    const schema = JSON.stringify(wire.schema);
    const codec = JSON.stringify(wire.codec);
    expect(wire.semanticType).toBe("EverythingInput");
    expect(schema).toContain('"wire_name"');
    expect(schema).not.toContain('"secret"');
    expect(schema).toContain('"contentEncoding":"base64"');
    expect(codec).toContain('"temporalKind"');
    expect(codec).toContain('"wireName":"wire_name"');
    expect(codec).toContain('"kind":"bigint-string"');
    expect(codec).toContain('"kind":"decimal-string"');
    expect(codec).toContain('"kind":"tuple"');
    expect(planner.emittedTypeNames).toContain("EverythingInput");

    // Reusing a projection key must preserve the original registered view.
    expect(
      planner.createWirePlan(everything, {
        projection: { key: "input", propertyFilter: () => true },
      }).semanticType,
    ).toBe("EverythingInput");

    const models = planner.emitModels();
    expect(models).toContain('import type { Temporal } from "@js-temporal/polyfill"');
    expect(models).toContain("export interface Everything");
    expect(models).toContain("export interface EverythingInput");
    expect(models).toContain("date: Temporal.PlainDate");
    expect(models).toContain("zoned: Temporal.ZonedDateTime");
    expect(models).toContain("export type StringMap = { known: Slug } & Record<string, Slug>");
    expect(models).toContain("@deprecated Use NewEverything.");
    expect(issues).toEqual([]);
  });

  test("handles canonical encodings, substitutions, streams, files, and diagnostics", async () => {
    const program = await compile(
      `
        using TypeSpec.Http;

        @encode(string) scalar Big extends int64;
        @encode(string) scalar DecimalText extends decimal;
        @minValue(-100) @maxValue(100) scalar Bounded extends int64;
        @encode(string) scalar BooleanText extends boolean;
        @encode(string) scalar IntText extends int32;
        @encode(string) scalar FloatText extends float64;
        @encode("base64url") scalar Token extends bytes;
        @encode("rfc3339") scalar Timestamp extends utcDateTime;
        @encode("ISO8601") scalar Period extends duration;
        @encode("rot13") scalar InvalidText extends string;

        model Original { original: string; }
        model Replacement { replacement: int32; }
        model Batch { values: string[]; }
        model NativeStream { value: string; }
        model Attachment extends File {}

        model Encoded {
          big: Big;
          decimal: DecimalText;
          bounded: Bounded;
          flag: BooleanText;
          integer: IntText;
          float: FloatText;
          token: Token;
          timestamp: Timestamp;
          period: Period;
          invalid: InvalidText;
          original: Original;
          batch: Batch;
          native: NativeStream;
          attachment: Attachment;
        }

        namespace Api { op nothing(): void; }
      `,
      true,
    );
    const global = program.getGlobalNamespaceType();
    const encoded = model(global, "Encoded");
    const original = model(global, "Original");
    const replacement = model(global, "Replacement");
    const batch = model(global, "Batch");
    const batchValues = batch.properties.get("values")!.type as Model;
    const batchElement = batchValues.indexer!.value;
    const nativeStream = model(global, "NativeStream");
    const issues: CodegenIssue[] = [];
    const planner = new TypePlanner(program, {
      canonicalJsonWire: true,
      datetimeMode: "date",
      typeSubstitutions: new Map([[original, replacement]]),
      streamElementTypes: new Map([[batch, batchElement]]),
      nativeStreamTypes: new Set([nativeStream]),
      onIssue: (issue) => issues.push(issue),
    });

    const plan = planner.createWirePlan(encoded);
    expect(planner.typeToTs(original)).toBe("Replacement");
    expect(planner.typeToTs(batch)).toBe("readonly string[]");
    expect(planner.typeToTs(nativeStream)).toBe("never");
    expect(planner.typeToTs(model(global, "Attachment"))).toBe("File");
    expect(JSON.stringify(plan.schema)).toContain('"contentEncoding":"base64"');
    expect(JSON.stringify(plan.codec)).toContain('"kind":"file"');
    expect(issues.some((issue) => issue.code === "unsupported-stream")).toBe(true);
    expect(issues.some((issue) => issue.code === "unsupported-encoding")).toBe(true);

    // Multiple roots exercise the union document wrapper and false-root metadata path.
    const multi = planner.createWirePlan([
      encoded.properties.get("big")!.type,
      encoded.properties.get("decimal")!.type,
    ]);
    expect(multi.semanticType).toBe("Big | DecimalText");
    const unsupported = planner.createWirePlan(nativeStream);
    expect(unsupported.schema).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      allOf: [false],
    });
    expect(isVoidType(operation(namespace(global, "Api"), "nothing").returnType)).toBe(true);
  });

  test("rejects unprepared names and reports unsafe native numeric representations once", async () => {
    const program = await compile(`
      scalar UnknownScalar;
      model Values {
        unsafeInteger: int64;
        unsafeDecimal: decimal;
        customValue: UnknownScalar;
        badDate: BadDate;
        badDuration: BadDuration;
        badBytes: BadBytes;
      }
      @encode("rfc7231") scalar BadDate extends utcDateTime;
      @encode("seconds", float64) scalar BadDuration extends duration;
      @encode("hex") scalar BadBytes extends bytes;
    `);
    const global = program.getGlobalNamespaceType();
    const values = model(global, "Values");
    const issues: CodegenIssue[] = [];
    const planner = new TypePlanner(program, { onIssue: (issue) => issues.push(issue) });

    expect(() => planner.getGeneratedName(values)).toThrow("was not prepared");
    planner.createWirePlan(values);
    planner.createWirePlan(values);
    expect(issues.filter((issue) => issue.code === "unsafe-number")).toHaveLength(2);
    expect(issues.filter((issue) => issue.code === "unsupported-encoding")).toHaveLength(3);
    expect(planner.emitModels()).toContain("export type UnknownScalar = unknown");
  });
});
