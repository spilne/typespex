import { describe, expect, test } from "bun:test";
import type { Model, Namespace, Operation, Type } from "@typespec/compiler";
import { createTestHost, createTestRunner } from "@typespec/compiler/testing";
import { HttpTestLibrary } from "@typespec/http/testing";
import {
  TypePlanner,
  isVoidType,
  renderTypeScriptModule,
  type CompilerIssue,
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
  test("omits identity codecs and wire aliases", async () => {
    const program = await compile(`model Pet { id: string; name: string; }`);
    const pet = model(program.getGlobalNamespaceType(), "Pet");
    const planner = new TypePlanner(program);
    const plan = planner.createWirePlan(pet);

    expect(plan.version).toBe(1);
    expect(plan.semanticType).toBe("Pet");
    expect(plan.wireType).toBe("Pet");
    expect(plan.referencedTypes).toEqual(["Pet"]);
    expect(plan.codec).toBeUndefined();
    expect(planner.createTypePlans()).toEqual([
      {
        version: 1,
        key: "Pet",
        name: "Pet",
        semanticType: "Pet",
        wireType: "Pet",
      },
    ]);
    expect(planner.emittedTypeNames).toEqual(["Pet"]);
    const modulePlan = planner.createModelModulePlan();
    expect(modulePlan.declarations).toHaveLength(1);
    expect(renderTypeScriptModule(modulePlan)).not.toContain("PetWire");
  });

  test("isolates recursive JSON documents across projections and incremental preparation", async () => {
    const program = await compile(`
      model Node { next?: Node; @encode(string) count: int32 = 7; }
      model Other { label: string; }
    `);
    const global = program.getGlobalNamespaceType();
    const node = model(global, "Node");
    const planner = new TypePlanner(program);
    const projection: TypeProjection = {
      key: "input",
      propertyFilter: (property) => property.name !== "count",
    };

    const projected = planner.createWirePlan(node, { projection });
    expect(projected.semanticType).toBe("NodeInput");
    expect(projected.wireType).toBe("NodeInput");
    expect(projected.codec).toBeUndefined();
    expect(projected.schema).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: { next: { $ref: "#/$defs/Node" } },
          additionalProperties: false,
        },
      },
    });

    const full = planner.createWirePlan(node);
    expect(full.wireType).toBe("NodeWire");
    expect(full.codec).toEqual({
      root: { kind: "ref", name: "Node" },
      definitions: {
        Node: {
          kind: "object",
          properties: {
            next: { wireName: "next", codec: { kind: "ref", name: "Node" }, optional: true },
            count: {
              wireName: "count",
              codec: { kind: "number-string", integer: true },
              optional: true,
              hasDefault: true,
              defaultValue: "7",
            },
          },
        },
      },
    });
    expect(full.schema).toMatchObject({
      $defs: { Node: { properties: { count: { type: "string", default: "7" } } } },
    });

    const other = planner.createWirePlan(model(global, "Other"));
    expect(other.codec).toBeUndefined();
    expect(other.schema).not.toHaveProperty("$defs.Node");
    expect(planner.createWirePlan(node, { projection })).toEqual(projected);
    expect(planner.createWirePlan(node)).toEqual(full);
  });

  test("records model references structurally in canonical order", async () => {
    const program = await compile(`
      model Pet { id: string; }
      model Zebra { id: string; }
      model Alpha { id: string; }
      op inspect(
        Pet: string,
        literal: "Pet",
        nested: { pet: Pet, zebra: Zebra, alpha: Alpha },
      ): Pet;
    `);
    const inspect = operation(program.getGlobalNamespaceType(), "inspect");
    const planner = new TypePlanner(program);

    const input = planner.createWirePlan(inspect.parameters);
    const output = planner.createWirePlan(inspect.returnType);

    expect(input.referencedTypes).toEqual(["Alpha", "Pet", "Zebra"]);
    expect(output.referencedTypes).toEqual(["Pet"]);
  });

  test("keeps unsafe numeric literals lossless across semantic and wire types", async () => {
    const program = await compile(`
      union ExactValues {
        integer: 9007199254740993,
        decimal: 1.234567890123456789,
      }
    `);
    const exactValues = program.getGlobalNamespaceType().unions.get("ExactValues");
    if (!exactValues) throw new Error("Expected ExactValues union.");
    const planner = new TypePlanner(program);
    const plan = planner.createWirePlan(exactValues);

    expect(plan.semanticType).toBe("ExactValues");
    expect(plan.wireType).toBe("ExactValuesWire");
    expect(JSON.stringify(plan.schema)).toContain('"const":"9007199254740993"');
    expect(JSON.stringify(plan.codec)).toContain('"kind":"bigint-literal-string"');
    const models = renderTypeScriptModule(planner.createModelModulePlan());
    expect(models).toContain(
      'export type ExactValues = 9007199254740993n | "1.234567890123456789";',
    );
    expect(models).toContain(
      'export type ExactValuesWire = "9007199254740993" | "1.234567890123456789";',
    );
  });

  test("reserves projection names when later roots are prepared", async () => {
    const program = await compile(`
      model Pet { id: string; internal: string; }
      model PetInput { value: string; }
    `);
    const global = program.getGlobalNamespaceType();
    const pet = model(global, "Pet");
    const declaredPetInput = model(global, "PetInput");
    const planner = new TypePlanner(program);

    const projected = planner.createWirePlan(pet, {
      projection: {
        key: "input",
        propertyFilter: (property) => property.name !== "internal",
      },
    });
    expect(projected.semanticType).toBe("PetInput");

    planner.prepare([declaredPetInput]);
    const declaredName = planner.getGeneratedName(declaredPetInput);
    expect(declaredName).not.toBe("PetInput");
    const models = renderTypeScriptModule(planner.createModelModulePlan());
    expect(models.match(/export interface PetInput\b/g)).toHaveLength(1);
    expect(models).toContain(`export interface ${declaredName}`);
  });

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

      model EncodedDefault {
        @encodedName("application/json", "wire_label") label: string;
        @encode(string) enabled: boolean;
        @encode(string) count: int32;
        when: utcDateTime;
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
        nested: EncodedDefault = #{
          label: "nested",
          enabled: true,
          count: 5,
          when: utcDateTime.fromISO("2024-02-03T04:05:06Z"),
        };
        nestedList: EncodedDefault[] = #[#{
          label: "listed",
          enabled: false,
          count: 6,
          when: utcDateTime.fromISO("2024-03-04T05:06:07Z"),
        }];
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
        instantDefault: utcDateTime = utcDateTime.fromISO("2024-01-02T03:04:05Z");
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
    const issues: CompilerIssue[] = [];
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
    expect(schema).toContain('"default":"2024-01-02T03:04:05Z"');
    expect(codec).toContain('"temporalKind"');
    expect(codec).toContain('"defaultValue":"2024-01-02T03:04:05Z"');
    expect(codec).toContain('"wireName":"wire_name"');
    expect(codec).toContain('"kind":"bigint-string"');
    expect(codec).toContain('"kind":"decimal-string"');
    expect(codec).toContain('"kind":"tuple"');
    expect(planner.emittedTypeNames).toContain("EverythingInput");

    const fullWire = planner.createWirePlan(everything);
    const fullSchema = fullWire.schema as {
      $defs: {
        Everything: {
          properties: Record<string, { default?: unknown }>;
        };
      };
    };
    expect(fullSchema.$defs.Everything.properties.nested?.default).toEqual({
      wire_label: "nested",
      enabled: "true",
      count: "5",
      when: "2024-02-03T04:05:06Z",
    });
    expect(fullSchema.$defs.Everything.properties.nestedList?.default).toEqual([
      {
        wire_label: "listed",
        enabled: "false",
        count: "6",
        when: "2024-03-04T05:06:07Z",
      },
    ]);

    // Reusing a projection key must preserve the original registered view.
    expect(
      planner.createWirePlan(everything, {
        projection: { key: "input", propertyFilter: () => true },
      }).semanticType,
    ).toBe("EverythingInput");

    const models = renderTypeScriptModule(planner.createModelModulePlan());
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
        @encode("rfc7231") scalar HttpTimestamp extends utcDateTime;
        @encode("unixTimestamp", int64) scalar EpochTimestamp extends utcDateTime;
        @encode("ISO8601") scalar Period extends duration;
        @encode("seconds", float64) scalar PeriodSeconds extends duration;
        @encode("milliseconds", int64) scalar PeriodMilliseconds extends duration;
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
          httpTimestamp: HttpTimestamp;
          epochTimestamp: EpochTimestamp;
          period: Period;
          periodSeconds: PeriodSeconds;
          periodMilliseconds: PeriodMilliseconds;
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
    const issues: CompilerIssue[] = [];
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
    expect(issues.filter((issue) => issue.code === "unsupported-encoding")).toHaveLength(1);

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

  test("keeps scalar defaults aligned with canonical JSON representations", async () => {
    const program = await compile(`
      @minValue(-10) @maxValue(10)
      scalar BoundedId extends int64;

      @encode(string) scalar LargeId extends int64;
      @encode(string) scalar Money extends decimal;
      @encode(string) scalar BooleanText extends boolean;

      model Defaults {
        bounded: BoundedId = 5;
        large: LargeId = 9007199254740993;
        money: Money = 12.50;
        flag: BooleanText = true;
        @encode(string) count: int32 = 7;
        instant: utcDateTime = utcDateTime.fromISO("2024-01-02T03:04:05Z");
      }
    `);
    const global = program.getGlobalNamespaceType();
    const issues: CompilerIssue[] = [];
    const planner = new TypePlanner(program, {
      canonicalJsonWire: true,
      onIssue: (issue) => issues.push(issue),
    });

    const schema = planner.createWirePlan(model(global, "Defaults")).schema as {
      $defs: {
        Defaults: {
          properties: Record<string, { default?: unknown }>;
        };
      };
    };
    const properties = schema.$defs.Defaults.properties;

    expect(properties.bounded?.default).toBe(5);
    expect(properties.large?.default).toBe("9007199254740993");
    expect(properties.money?.default).toBe("12.5");
    expect(properties.flag?.default).toBe(true);
    expect(properties.count?.default).toBe(7);
    expect(properties.instant?.default).toBe("2024-01-02T03:04:05Z");
    expect(issues).toEqual([]);
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
    const issues: CompilerIssue[] = [];
    const planner = new TypePlanner(program, { onIssue: (issue) => issues.push(issue) });

    expect(() => planner.getGeneratedName(values)).toThrow("was not prepared");
    planner.createWirePlan(values);
    planner.createWirePlan(values);
    expect(issues.filter((issue) => issue.code === "unsafe-number")).toHaveLength(2);
    expect(issues.filter((issue) => issue.code === "unsupported-encoding")).toHaveLength(3);
    expect(renderTypeScriptModule(planner.createModelModulePlan())).toContain(
      "export type UnknownScalar = unknown",
    );
  });

  test("reports unserializable defaults independently for properties with the same name", async () => {
    const program = await compile(`
      scalar Custom extends string { init fromValue(value: string); }
      model First { createdAt: Custom = Custom.fromValue("first"); }
      model Second { createdAt: Custom = Custom.fromValue("second"); }
    `);
    const global = program.getGlobalNamespaceType();
    const issues: CompilerIssue[] = [];
    const planner = new TypePlanner(program, { onIssue: (issue) => issues.push(issue) });

    planner.createWirePlan(model(global, "First"));
    planner.createWirePlan(model(global, "Second"));

    expect(issues.filter((issue) => issue.code === "unsupported-type")).toHaveLength(2);
    expect(issues.map((issue) => issue.message)).toContain(
      "Default value for First.createdAt cannot be represented on the JSON wire.",
    );
    expect(issues.map((issue) => issue.message)).toContain(
      "Default value for Second.createdAt cannot be represented on the JSON wire.",
    );
  });
});

describe("renderTypeScriptModule", () => {
  test("renders every module section with stable spacing", () => {
    expect(renderTypeScriptModule({ banner: "// Banner", imports: [], declarations: [] })).toBe(
      "// Banner\n",
    );
    expect(
      renderTypeScriptModule({
        banner: "// Banner",
        imports: ['import type { Pet } from "./pet.js";'],
        declarations: [],
      }),
    ).toBe('// Banner\nimport type { Pet } from "./pet.js";\n\n');
    expect(
      renderTypeScriptModule({
        banner: "// Banner",
        imports: [],
        declarations: ["export interface Pet {}"],
      }),
    ).toBe("// Banner\nexport interface Pet {}\n");
    expect(
      renderTypeScriptModule({
        banner: "// Banner",
        imports: [
          'import type { Pet } from "./pet.js";',
          'import type { Owner } from "./owner.js";',
        ],
        declarations: ["export interface Pet {}", "export interface Owner {}"],
      }),
    ).toBe(
      '// Banner\nimport type { Pet } from "./pet.js";\nimport type { Owner } from "./owner.js";\n\nexport interface Pet {}\n\nexport interface Owner {}\n',
    );
  });
});
