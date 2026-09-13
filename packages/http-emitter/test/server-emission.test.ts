import { describe, expect, test } from "bun:test";
import { createTestHost, createTestRunner } from "@typespec/compiler/testing";
import { getAllHttpServices } from "@typespec/http";
import { HttpTestLibrary } from "@typespec/http/testing";
import { createEmitterContext } from "../src/ctx.js";
import { emitServer } from "../src/emit-server.js";
import { emitServerOperations } from "../src/emit-server-operations.js";
import { getPayloadTypeAliasDeclarations } from "../src/payload-context.js";
import { buildServerEmission } from "../src/server-emission.js";

describe("server emission", () => {
  test("captures every handler payload alias before rendering begins", async () => {
    const host = await createTestHost({ libraries: [HttpTestLibrary] });
    const runner = await createTestRunner(host);
    const [, diagnostics] = await runner.compileAndDiagnose(`
      using TypeSpec.Http;

      @service namespace AliasApi {
        model Pet { id: string; }

        @error model NotFound {
          @statusCode _: 404;
          code: "NOT_FOUND";
          cause?: NotFound;
        }

        @get @route("/pets/{id}")
        op read(@path id: string): Pet | NotFound;
      }
    `);
    expect(diagnostics).toHaveLength(0);

    const [services, httpDiagnostics] = getAllHttpServices(runner.program);
    expect(httpDiagnostics).toHaveLength(0);
    const service = services[0];
    if (!service) throw new Error("Expected an HTTP service.");

    const ctx = createEmitterContext(runner.program, service, {});
    const emission = buildServerEmission(ctx, service.operations);
    const serverBeforeOperations = emitServer(ctx, emission);

    expect(emission.payloadTypeAliases.length).toBeGreaterThan(0);
    expect(missingPayloadAliasDeclarations(serverBeforeOperations)).toEqual([]);

    emitServerOperations(ctx, service.operations, emission);

    expect(getPayloadTypeAliasDeclarations(ctx)).toEqual(emission.payloadTypeAliases);
    expect(emitServer(ctx, emission)).toBe(serverBeforeOperations);
  });
});

function missingPayloadAliasDeclarations(source: string): string[] {
  const referenced = new Set(
    [...source.matchAll(/\b(_TypespexPayload_[A-Za-z0-9_]+)\b/g)].map((match) => match[1]!),
  );
  const declared = new Set(
    [...source.matchAll(/^type (_TypespexPayload_[A-Za-z0-9_]+)\b/gm)].map((match) => match[1]!),
  );
  return [...referenced].filter((name) => !declared.has(name)).sort();
}
