import { expect, test } from "bun:test";
import type { Model } from "@typespec/compiler";
import { createTestHost, createTestRunner } from "@typespec/compiler/testing";
import { TypePlanner, type CompilerIssue } from "../src/unstable.js";

test("rejects opaque scalar-constructor defaults", async () => {
  const host = await createTestHost();
  const runner = await createTestRunner(host);
  const [, diagnostics] = await runner.compileAndDiagnose(`
    scalar Custom extends string { init fromValue(value: string); }
    scalar CustomDate extends utcDateTime { init fromValue(value: string); }
    model First { createdAt: Custom = Custom.fromValue("first"); }
    model Second { createdAt: Custom = Custom.fromValue("second"); }
    model Third { createdAt: CustomDate = CustomDate.fromValue("2026-08-16T00:00:00Z"); }
  `);
  expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);

  const global = runner.program.getGlobalNamespaceType();
  const first = global.models.get("First") as Model | undefined;
  const second = global.models.get("Second") as Model | undefined;
  const third = global.models.get("Third") as Model | undefined;
  if (!first || !second || !third) throw new Error("Expected scalar default fixture models.");
  const issues: CompilerIssue[] = [];
  const planner = new TypePlanner(runner.program, { onIssue: (issue) => issues.push(issue) });

  planner.createWirePlan(first);
  planner.createWirePlan(second);
  planner.createWirePlan(third);

  expect(issues.filter((issue) => issue.code === "unsupported-type")).toHaveLength(3);
  expect(issues.map((issue) => issue.message)).toContain(
    "Default value for First.createdAt cannot be represented on the JSON wire.",
  );
  expect(issues.map((issue) => issue.message)).toContain(
    "Default value for Second.createdAt cannot be represented on the JSON wire.",
  );
  expect(issues.map((issue) => issue.message)).toContain(
    "Default value for Third.createdAt cannot be represented on the JSON wire.",
  );
});

test("diagnoses numeric defaults outside property bounds, including nested objects", async () => {
  const runner = await createTestRunner(await createTestHost());
  const [, diagnostics] = await runner.compileAndDiagnose(`
    model Encoded { @encode(string) @minValue(1) value: int32 = 0; }
    model Native { @maxValue(10) value: float64 = 11; }
    model Element { @encode(string) @minValueExclusive(1) value: int32; }
    model Nested { element: Element = #{ value: 1 }; }
    model Valid { @encode(string) @minValue(1) @maxValue(10) value: int32 = 10; }
  `);
  expect(diagnostics).toHaveLength(0);
  const issues: CompilerIssue[] = [];
  const planner = new TypePlanner(runner.program, { onIssue: (issue) => issues.push(issue) });
  const models = runner.program.getGlobalNamespaceType().models;
  for (const name of ["Encoded", "Native", "Nested", "Valid"])
    planner.createWirePlan(models.get(name)!);
  expect(issues).toHaveLength(3);
  for (const [name, constraint] of [
    ["Encoded.value", "at least 1"],
    ["Native.value", "at most 10"],
    ["Nested.element", "greater than 1"],
  ]) {
    expect(
      issues.some(
        (issue) =>
          issue.code === "unsupported-type" &&
          issue.message.includes(name!) &&
          issue.message.includes(constraint!),
      ),
    ).toBe(true);
  }
});
