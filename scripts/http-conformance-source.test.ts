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

const specialWordsScenarioSource = `
import "@typespec/http";
import "@typespec/spector";
import "./dec.js";

using Http;
using Spector;

@scenarioService("/special-words")
namespace SpecialWords;

interface Operations {
  @opNameScenario("await") await(): void;
}

interface Parameters {
  @paramNameScenario("await") withAwait(@query await: string): void;
}

model await { name: string; }
@modelNameScenario("await") op withAwaitModel(@body body: await): void;
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
      /Could not parse TypeSpec HTTP scenario encode\/malformed.*First diagnostic: <anonymous file>:\d+:\d+ - error .+: .+/,
    );
  });

  test("replaces special-word scenario helpers with their declared routes", () => {
    const transformed = removeScenarioRunnerMetadata(specialWordsScenarioSource, "special-words");

    expect(transformed).not.toContain("./dec.js");
    expect(transformed).not.toContain("NameScenario");
    expect(transformed.match(/@route\("\/await"\)/g)).toHaveLength(3);
    expect(transformed).toContain('@route("/special-words")');
  });
});
