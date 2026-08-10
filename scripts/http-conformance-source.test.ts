import { describe, expect, test } from "bun:test";
import { removeScenarioRunnerMetadata } from "./http-conformance-source.js";

const structuredScenarioSource = `
import "@typespec/http";
import "@typespec/spector";

using Http;
using Spector;

@scenarioService("/encode/structured")
namespace Encode.Structured;

interface Send<Value extends string> {
  @scenario
  @scenarioDoc(
    """
      A multiline description whose interpolation data is structured.
      Expected value: {value}
      Parentheses in documentation are preserved: (example).
      """,
    {
      value: Value,
    }
  )
  @post
  send(@body value: string): string;
}
`;

describe("TypeSpec HTTP conformance source transform", () => {
  test("removes complete structured scenario decorator applications", () => {
    const transformed = removeScenarioRunnerMetadata(structuredScenarioSource, "encode/structured");

    expect(transformed).not.toContain("@typespec/spector");
    expect(transformed).not.toContain("using Spector");
    expect(transformed).not.toContain("@scenario");
    expect(transformed).not.toContain("value: Value");
    expect(transformed).toContain('@service(#{ title: "TypeSpec HTTP conformance" })');
    expect(transformed).toContain('@route("/encode/structured")');
    expect(transformed).toContain("interface Send<Value extends string>");
    expect(transformed).toContain("@post");
  });

  test("rejects malformed sources before attempting text transformation", () => {
    const malformed = structuredScenarioSource.replace("send(@body", "send((@body");

    expect(() => removeScenarioRunnerMetadata(malformed, "encode/malformed")).toThrow(
      "Could not parse TypeSpec HTTP scenario encode/malformed",
    );
  });
});
