import { describe, expect, test } from "bun:test";
import { createTestHost, createTestRunner } from "@typespec/compiler/testing";
import type { Scalar } from "@typespec/compiler";
import { ScalarPlanner } from "../packages/compiler-core/src/scalar-planner.js";
import { createEmitterContext } from "../packages/http-emitter/src/ctx.js";
import { scalarToTs } from "../packages/http-emitter/src/scalar-map.js";
import { resolveScalarEncoding } from "../packages/http-emitter/src/scalar-encoding.js";
import { createHttpWireValuePlan } from "../packages/mcp-emitter/src/http-wire-planner.js";

async function fixture(source: string) {
  const runner = await createTestRunner(await createTestHost());
  const [, diagnostics] = await runner.compileAndDiagnose(source);
  expect(diagnostics).toHaveLength(0);
  const program = runner.program;
  const namespace = program.getGlobalNamespaceType();
  const model = namespace.models.get("Values")!;
  const ctx = createEmitterContext(program, { namespace, operations: [] }, {});
  const json = new ScalarPlanner(program, {
    canonicalJsonWire: true,
    report: (_code, message) => {
      throw new Error(message);
    },
  });
  return { program, model, ctx, json };
}

describe("scalar policy across compiler paths", () => {
  test("preserves intentional handler and wire representation differences", async () => {
    const { program, model, ctx, json } = await fixture(`
      @minValue(-10) @maxValue(10) @encode(string) scalar Small extends int64;
      model Values {
        @encode(string) count: int32;
        @encode(string) large: int64;
        @encode(string) arbitrary: integer;
        @encode(string) decimal: decimal;
        small: Small;
        @encode(string) flag: boolean;
        @encode("rfc7231") timestamp: utcDateTime;
        @encode("seconds", float64) elapsed: duration;
        @encode("base64url") token: bytes;
      }
    `);
    const cases = [
      // property, MCP semantic type, HTTP handler type, MCP JSON type, HTTP encoding, bridge plan
      [
        "count",
        "number",
        "number",
        "integer",
        "number-string",
        { kind: "scalar-encoding", encoding: "integer-string" },
      ],
      ["large", "bigint", "bigint", "string", "bigint-string", { kind: "string" }],
      ["arbitrary", "bigint", "number", "string", "number-string", { kind: "string" }],
      ["decimal", "string", "number", "string", "number-string", { kind: "string" }],
      [
        "small",
        "bigint",
        "bigint",
        "integer",
        "bigint-string",
        { kind: "scalar-encoding", encoding: "integer-string" },
      ],
      [
        "flag",
        "boolean",
        "boolean",
        "boolean",
        "boolean-string",
        { kind: "scalar-encoding", encoding: "boolean-string" },
      ],
      [
        "timestamp",
        "string",
        "string",
        "string",
        "rfc7231",
        { kind: "scalar-encoding", encoding: "rfc7231" },
      ],
      [
        "elapsed",
        "string",
        "string",
        "string",
        "duration-seconds",
        { kind: "scalar-encoding", encoding: "duration-seconds" },
      ],
      [
        "token",
        "Uint8Array",
        "Uint8Array",
        "string",
        "base64url",
        { kind: "scalar-encoding", encoding: "base64url" },
      ],
    ] as const;
    for (const [name, semantic, handler, wire, encoding, bridge] of cases) {
      const property = model.properties.get(name)!;
      const scalar = property.type as Scalar;
      expect(json.semanticType(scalar)).toBe(semantic);
      expect(scalarToTs(scalar)).toBe(handler);
      expect(json.schema(scalar, property)).toMatchObject({ type: wire });
      expect(resolveScalarEncoding(ctx, scalar, property)).toMatchObject({
        status: "supported",
        plan: { kind: encoding },
      });
      expect(createHttpWireValuePlan(program, scalar, property, "application/json")).toEqual(
        bridge,
      );
    }
  });

  test("keeps HTTP header, text, binary, and JSON defaults distinct", async () => {
    const { program, model, ctx, json } = await fixture(`
      model Values { timestamp: utcDateTime; token: bytes; }
    `);
    const timestamp = model.properties.get("timestamp")!;
    const scalar = timestamp.type as Scalar;
    expect(resolveScalarEncoding(ctx, scalar, timestamp, "header")).toMatchObject({
      status: "supported",
      plan: { kind: "rfc7231" },
    });
    expect(resolveScalarEncoding(ctx, scalar, timestamp, "value")).toMatchObject({
      status: "supported",
      plan: { kind: "rfc3339" },
    });
    expect(resolveScalarEncoding(ctx, scalar, timestamp, "binary")).toEqual({ status: "none" });
    expect(json.schema(scalar, timestamp)).toEqual({ type: "string", format: "date-time" });
    expect(createHttpWireValuePlan(program, scalar, timestamp, undefined, "header")).toEqual({
      kind: "scalar-encoding",
      encoding: "rfc7231",
    });
    expect(createHttpWireValuePlan(program, scalar, timestamp, undefined, "value")).toEqual({
      kind: "string",
    });
    const token = model.properties.get("token")!;
    expect(resolveScalarEncoding(ctx, token.type as Scalar, token, "text")).toMatchObject({
      status: "supported",
      plan: { kind: "base64" },
    });
    expect(resolveScalarEncoding(ctx, token.type as Scalar, token, "binary")).toEqual({
      status: "none",
    });
  });

  test("resolves the nearest scalar encoding and then the property override", async () => {
    const { program, model, ctx, json } = await fixture(`
      @encode("rfc7231") scalar HeaderDate extends utcDateTime;
      scalar InheritedDate extends HeaderDate;
      model Values {
        inherited: InheritedDate;
        @encode("rfc3339") overridden: InheritedDate;
      }
    `);
    for (const [name, kind] of [
      ["inherited", "rfc7231"],
      ["overridden", "rfc3339"],
    ] as const) {
      const property = model.properties.get(name)!;
      const scalar = property.type as Scalar;
      const resolution = resolveScalarEncoding(ctx, scalar, property);
      expect(resolution).toMatchObject({ status: "supported", plan: { kind } });
      if (resolution.status !== "supported") throw new Error("Expected encoding.");
      expect(resolution.plan.source).toBe(name === "inherited" ? scalar.baseScalar : property);
      expect(json.schema(scalar, property)).toEqual({ type: "string", format: "date-time" });
      expect(createHttpWireValuePlan(program, scalar, property, undefined)).toEqual(
        name === "inherited"
          ? { kind: "scalar-encoding", encoding: "rfc7231" }
          : { kind: "string" },
      );
    }
  });
});
