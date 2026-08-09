import type {
  DiagnosticTarget,
  Enum,
  ModelProperty,
  NumericLiteral,
  Type,
} from "@typespec/compiler";
import { walkPropertiesInherited } from "@typespec/compiler";
import type { HttpOperation } from "@typespec/http";
import type { EmitterCtx } from "./ctx.js";
import { $lib } from "./lib.js";
import { getAdditionalPropertiesValues } from "./model-indexer.js";
import { getEnumMemberNumericLiteral, resolveNumericLiteral } from "./numeric-literals.js";

/** Reports exact numeric contracts the generated number/bigint runtime cannot preserve. */
export function reportUnsupportedNumericLiterals(
  ctx: EmitterCtx,
  operations: readonly HttpOperation[],
): void {
  const seen = new Set<Type>();
  const reported = new Set<object>();

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

    switch (type.kind) {
      case "Number":
        report(type, target);
        return;
      case "Enum":
        visitEnum(type);
        return;
      case "EnumMember": {
        const source = getEnumMemberNumericLiteral(ctx.program, type);
        if (source) report(source, type);
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

  function visitEnum(type: Enum): void {
    for (const member of type.members.values()) {
      const source = getEnumMemberNumericLiteral(ctx.program, member);
      if (source) report(source, member);
    }
  }

  function report(type: NumericLiteral, target: DiagnosticTarget): void {
    const reportKey =
      typeof target === "object" && target !== null && "node" in target
        ? (target.node ?? type.node ?? target)
        : (type.node ?? type);
    if (reported.has(reportKey)) return;
    const resolution = resolveNumericLiteral(type);
    if (resolution.supported) return;
    reported.add(reportKey);
    $lib.reportDiagnostic(ctx.program, {
      code: "unsupported-numeric-literal",
      format: { value: resolution.exactValue, reason: resolution.reason },
      target,
    });
  }
}

function sourceProperty(property: ModelProperty): ModelProperty {
  let current = property;
  while (current.sourceProperty) current = current.sourceProperty;
  return current;
}
