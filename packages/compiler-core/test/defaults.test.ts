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
