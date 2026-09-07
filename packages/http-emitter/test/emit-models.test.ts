import { describe, expect, test } from "bun:test";
import { createTestHost, createTestRunner } from "@typespec/compiler/testing";
import { getAllHttpServices } from "@typespec/http";
import { HttpTestLibrary } from "@typespec/http/testing";
import { createEmitterContext } from "../src/ctx.js";
import { emitModels } from "../src/emit-models.js";

describe("model emission", () => {
  test("is repeatable for one compiler context", async () => {
    const host = await createTestHost({ libraries: [HttpTestLibrary] });
    const runner = await createTestRunner(host);
    const [, diagnostics] = await runner.compileAndDiagnose(`
      using TypeSpec.Http;

      @service namespace RepeatableApi {
        model Pet { id: string; }
        enum Kind { cat, dog }
        union Result { pet: Pet, missing: "missing" }
        @route("/pets") @get op list(): Result[];
      }
    `);

    expect(diagnostics).toHaveLength(0);
    const [services, httpDiagnostics] = getAllHttpServices(runner.program);
    expect(httpDiagnostics).toHaveLength(0);
    const service = services[0];
    if (!service) throw new Error("Expected an HTTP service.");
    const ctx = createEmitterContext(runner.program, service, {});

    const first = emitModels(ctx);
    const second = emitModels(ctx);

    expect(second).toBe(first);
    expect(first.match(/export interface Pet\b/g)).toHaveLength(1);
    expect(first.match(/export type Kind\b/g)).toHaveLength(1);
    expect(first.match(/export type Result\b/g)).toHaveLength(1);
  });
});
