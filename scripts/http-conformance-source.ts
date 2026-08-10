// Use the same integrity-locked compiler instance that compiles the conformance fixtures.
import {
  parse,
  SyntaxKind,
  visitChildren,
  type Node,
} from "../example/node_modules/@typespec/compiler/dist/src/ast/index.js";

interface SourceRange {
  readonly pos: number;
  readonly end: number;
}

export function removeScenarioRunnerMetadata(source: string, scenario: string): string {
  const serviceMatches = [...source.matchAll(/@scenarioService\("([^"]+)"\)/g)];
  if (serviceMatches.length !== 1) {
    throw new Error(`Expected one @scenarioService decorator in ${scenario}.`);
  }

  const transformed = removeDecoratorApplications(source, "scenarioDoc", scenario)
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

function removeDecoratorApplications(source: string, name: string, scenario: string): string {
  const script = parse(source);
  if (script.parseDiagnostics.length > 0) {
    throw new Error(
      `Could not parse TypeSpec HTTP scenario ${scenario} before transforming metadata ` +
        `(${script.parseDiagnostics.length} diagnostics).`,
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
