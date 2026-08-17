import { describe, expect, test } from "bun:test";
import { createTestHost, createTestRunner } from "@typespec/compiler/testing";
import { getAllHttpServices } from "@typespec/http";
import { HttpTestLibrary } from "@typespec/http/testing";
import { createEmitterContext } from "../src/ctx.js";
import { buildHoistedDecoders } from "../src/server-value-decoders.js";

describe("server value decoder emission", () => {
  test("retains hoisted declarations across repeated collection passes", async () => {
    const host = await createTestHost({ libraries: [HttpTestLibrary] });
    const runner = await createTestRunner(host);
    const [, diagnostics] = await runner.compileAndDiagnose(`
      using TypeSpec.Http;

      @service(#{ title: "RecursiveInputsApi" })
      namespace RecursiveInputsApi {
        model QueryNode {
          value: string;
          child?: QueryNode;
        }

        model BodyNode {
          value: string;
          child?: BodyNode;
        }

        @route("/both")
        @post op both(@query query: QueryNode, @body body: BodyNode): void;
      }
    `);

    expect(diagnostics).toHaveLength(0);
    const [services, httpDiagnostics] = getAllHttpServices(runner.program);
    expect(httpDiagnostics).toHaveLength(0);

    const service = services[0];
    const queryNode = service?.namespace.models.get("QueryNode");
    const bodyNode = service?.namespace.models.get("BodyNode");
    if (!service || !queryNode || !bodyNode) throw new Error("Expected recursive input models");

    const ctx = createEmitterContext(runner.program, service, {});
    const queryLazy = {
      type: queryNode,
      mode: "json" as const,
      varName: "_lazyQueryNode",
    };
    const decoderContext = {
      scopeName: "Both",
      lazyDecoders: new Map([[queryNode, new Map([["json:raw" as const, queryLazy]])]]),
      emittedLazy: new Set<typeof queryLazy>(),
      hoistedDecoderLines: [] as string[],
    };

    const firstPass = buildHoistedDecoders(ctx, decoderContext);
    expect(firstPass).toHaveLength(1);

    decoderContext.lazyDecoders.set(
      bodyNode,
      new Map([
        [
          "json:raw",
          {
            type: bodyNode,
            mode: "json",
            varName: "_lazyBodyNode",
          },
        ],
      ]),
    );
    const secondPass = buildHoistedDecoders(ctx, decoderContext);
    const thirdPass = buildHoistedDecoders(ctx, decoderContext);
    const declarations = secondPass.join("\n");

    expect(secondPass).toHaveLength(2);
    expect(thirdPass).toEqual(secondPass);
    expect(declarations).toContain("Decoder<QueryNode>");
    expect(declarations).toContain("Decoder<BodyNode>");
  });
});
