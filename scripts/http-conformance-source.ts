import { formatDiagnostic } from "@typespec/compiler";
import { parse, SyntaxKind, visitChildren, type Node } from "@typespec/compiler/ast";

interface SourceRange {
  readonly pos: number;
  readonly end: number;
}

export function removeScenarioRunnerMetadata(source: string, scenario: string): string {
  const prepared = prepareScenarioSource(source, scenario);
  const serviceMatches = [...prepared.matchAll(/@scenarioService\("([^"]+)"\)/g)];
  if (serviceMatches.length !== 1) {
    throw new Error(`Expected one @scenarioService decorator in ${scenario}.`);
  }

  const transformed = removeDecoratorApplications(prepared, "scenarioDoc", scenario)
    .replace(/^import "@typespec\/spector";\r?\n/m, "")
    .replace(/^using Spector;\r?\n/m, "")
    .replace(/^\s*@scenario\s*$\r?\n/gm, "")
    .replace(
      /@scenarioService\("([^"]+)"\)/,
      '@service(#{ title: "TypeSpec HTTP conformance" })\n@route("$1")',
    );

  if (transformed.includes("Spector") || transformed.includes("@scenario")) {
    throw new Error(`Could not remove all scenario-runner metadata from ${scenario}.`);
  }
  return transformed;
}

function prepareScenarioSource(source: string, scenario: string): string {
  if (scenario !== "special-words") return source;

  return source
    .replace(/^import "\.\/dec\.js";\r?\n/m, "")
    .replace(
      /@(?:opName|paramName|modelName)Scenario\("([^"]+)"\)/g,
      (_application, name: string) => `@route(${JSON.stringify(`/${name}`)})`,
    );
}

function removeDecoratorApplications(source: string, name: string, scenario: string): string {
  const script = parse(source);
  if (script.parseDiagnostics.length > 0) {
    const firstDiagnostic = formatDiagnostic(script.parseDiagnostics[0]);
    throw new Error(
      `Could not parse TypeSpec HTTP scenario ${scenario} before transforming metadata ` +
        `(${script.parseDiagnostics.length} diagnostics). First diagnostic: ${firstDiagnostic}`,
    );
  }

  const ranges: SourceRange[] = [];
  function visit(node: Node): void {
    if (
      node.kind === SyntaxKind.DecoratorExpression &&
      node.target.kind === SyntaxKind.Identifier &&
      node.target.sv === name
    ) {
      ranges.push({ pos: node.pos, end: node.end });
    }
    visitChildren(node, visit);
  }
  visit(script);

  let transformed = source;
  ranges.sort((left, right) => right.pos - left.pos);
  for (const range of ranges) {
    transformed = `${transformed.slice(0, range.pos)}${transformed.slice(range.end)}`;
  }
  return transformed;
}
