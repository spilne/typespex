import type {
  DiagnosticTarget,
  Enum,
  ModelProperty,
  NumericLiteral,
  StringTemplate,
  Type,
  Value,
} from "@typespec/compiler";
import { isType, isValue, walkPropertiesInherited } from "@typespec/compiler";
import { SyntaxKind } from "@typespec/compiler/ast";
import type { HttpOperation } from "@typespec/http";
import type { EmitterCtx } from "./ctx.js";
import { $lib } from "./lib.js";
import { getAdditionalPropertiesValues } from "./model-indexer.js";
import { getEnumMemberNumericLiteral, resolveNumericLiteral } from "./numeric-literals.js";

/** Reports literal contracts the generated runtime cannot preserve faithfully. */
export function reportUnsupportedLiterals(
  ctx: EmitterCtx,
  operations: readonly HttpOperation[],
): void {
  const seen = new Set<Type>();
  const reported = new Set<object>();
  const emittedDeclarations = new Set<Type>(ctx.namedTypes);

  for (const type of ctx.namedTypes) visit(type);
  for (const operation of operations) {
    for (const parameter of operation.parameters.parameters) {
      visit(parameter.param.type, sourceProperty(parameter.param));
    }
    if (operation.parameters.body) {
      visit(
        operation.parameters.body.type,
        operation.parameters.body.property
          ? sourceProperty(operation.parameters.body.property)
          : operation.operation,
      );
    }
    visit(operation.operation.returnType, operation.operation);
    for (const response of operation.responses) {
      visit(response.type, operation.operation);
      for (const content of response.responses) {
        if (content.body) {
          visit(
            content.body.type,
            content.body.property ? sourceProperty(content.body.property) : operation.operation,
          );
        }
      }
    }
  }

  function visit(type: Type, target: DiagnosticTarget = type): void {
    if (seen.has(type)) return;
    seen.add(type);
    visitTemplateArguments(type);
    if (emittedDeclarations.has(type)) visitTemplateParameterTypes(type);

    switch (type.kind) {
      case "Number":
        reportNumeric(type, target);
        return;
      case "StringTemplate":
        reportStringTemplate(type, target);
        return;
      case "Enum":
        visitEnum(type);
        return;
      case "EnumMember": {
        const source = getEnumMemberNumericLiteral(ctx.program, type);
        if (source) reportNumeric(source, type);
        return;
      }
      case "Model":
        if (type.baseModel) visit(type.baseModel, type.baseModel);
        for (const property of walkPropertiesInherited(type)) {
          visit(property.type, sourceProperty(property));
        }
        for (const additional of getAdditionalPropertiesValues(type)) visit(additional, type);
        return;
      case "Union":
        for (const variant of type.variants.values()) visit(variant.type, variant);
        return;
      case "Tuple":
        for (const value of type.values) visit(value, target);
        return;
      case "ModelProperty":
        visit(type.type, sourceProperty(type));
        return;
      case "UnionVariant":
        visit(type.type, type);
        return;
      default:
        return;
    }
  }

  function visitTemplateArguments(type: Type): void {
    if (!("templateMapper" in type)) return;
    for (const argument of type.templateMapper?.args ?? []) {
      if (isType(argument)) {
        visit(argument);
      } else if (isValue(argument)) {
        const exactType = ctx.program.checker.getValueExactType(argument as Value);
        if (exactType) visit(exactType);
      } else if ("type" in argument && isType(argument.type)) {
        visit(argument.type);
      }
    }
  }

  function visitTemplateParameterTypes(type: Type): void {
    if (type.kind !== "Model" && type.kind !== "Scalar" && type.kind !== "Union") return;
    const node = type.node;
    if (!node || !("templateParameters" in node)) return;

    for (const parameter of node.templateParameters) {
      if (parameter.constraint) {
        const constraint =
          parameter.constraint.kind === SyntaxKind.ValueOfExpression
            ? parameter.constraint.target
            : parameter.constraint;
        visit(ctx.program.checker.getTypeForNode(constraint), constraint);
      }
      if (parameter.default) {
        visit(ctx.program.checker.getTypeForNode(parameter.default), parameter.default);
      }
    }
  }

  function visitEnum(type: Enum): void {
    for (const member of type.members.values()) {
      const source = getEnumMemberNumericLiteral(ctx.program, member);
      if (source) reportNumeric(source, member);
    }
  }

  function reportNumeric(type: NumericLiteral, target: DiagnosticTarget): void {
    const resolution = resolveNumericLiteral(type);
    if (resolution.supported || alreadyReported(target, type)) return;
    $lib.reportDiagnostic(ctx.program, {
      code: "unsupported-numeric-literal",
      format: { value: resolution.exactValue, reason: resolution.reason },
      target,
    });
  }

  function reportStringTemplate(type: StringTemplate, target: DiagnosticTarget): void {
    if (type.stringValue !== undefined || alreadyReported(target, type)) return;
    $lib.reportDiagnostic(ctx.program, {
      code: "unsupported-string-template",
      target,
    });
  }

  function alreadyReported(target: DiagnosticTarget, fallback: Type): boolean {
    const reportKey =
      typeof target === "object" && target !== null && "node" in target
        ? (target.node ?? fallback.node ?? target)
        : (fallback.node ?? fallback);
    if (reported.has(reportKey)) return true;
    reported.add(reportKey);
    return false;
  }
}

function sourceProperty(property: ModelProperty): ModelProperty {
  let current = property;
  while (current.sourceProperty) current = current.sourceProperty;
  return current;
}
