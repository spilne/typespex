import type { Numeric, Type } from "@typespec/compiler";
import {
  getMaxItems,
  getMaxLength,
  getMaxValueAsNumeric,
  getMaxValueExclusiveAsNumeric,
  getMinItems,
  getMinLength,
  getMinValueAsNumeric,
  getMinValueExclusiveAsNumeric,
  getPatternData,
  isArrayModelType,
} from "@typespec/compiler";
import type { EmitterCtx } from "./ctx.js";
import { getDateTimeMode } from "./datetime-mode.js";
import { scalarToTs } from "./scalar-map.js";
import { tsLiteral } from "./typescript-names.js";

export type DecodedTypeKind = "number" | "bigint" | "string" | "bytes" | "array" | "other";

export interface ValidationRule {
  readonly kind:
    | "minValue"
    | "maxValue"
    | "minValueExclusive"
    | "maxValueExclusive"
    | "minLength"
    | "maxLength"
    | "minItems"
    | "maxItems"
    | "pattern";
  /** TypeScript expression for the bound or pattern. */
  readonly argument: string;
  readonly message?: string;
}

/** Runtime validators declared directly on a TypeSpec type. */
export function emitValidatorsForTarget(
  ctx: EmitterCtx,
  target: Type,
  kind: DecodedTypeKind,
): string[] {
  return getValidationRules(ctx, target, kind).map(
    (rule) =>
      `Validators.${rule.kind}(${rule.argument}${rule.message ? `, ${tsLiteral(rule.message)}` : ""})`,
  );
}

export function getValidationRules(
  ctx: EmitterCtx,
  target: Type,
  kind: DecodedTypeKind,
): ValidationRule[] {
  const program = ctx.program;
  const validators: ValidationRule[] = [];

  const minValue = getMinValueAsNumeric(program, target);
  if (minValue) {
    validators.push({ kind: "minValue", argument: emitNumericValue(minValue, kind === "bigint") });
  }

  const maxValue = getMaxValueAsNumeric(program, target);
  if (maxValue) {
    validators.push({ kind: "maxValue", argument: emitNumericValue(maxValue, kind === "bigint") });
  }

  const minValueExclusive = getMinValueExclusiveAsNumeric(program, target);
  if (minValueExclusive) {
    validators.push({
      kind: "minValueExclusive",
      argument: emitNumericValue(minValueExclusive, kind === "bigint"),
    });
  }

  const maxValueExclusive = getMaxValueExclusiveAsNumeric(program, target);
  if (maxValueExclusive) {
    validators.push({
      kind: "maxValueExclusive",
      argument: emitNumericValue(maxValueExclusive, kind === "bigint"),
    });
  }

  const minLength = getMinLength(program, target);
  if (minLength !== undefined) {
    validators.push({ kind: "minLength", argument: String(minLength) });
  }

  const maxLength = getMaxLength(program, target);
  if (maxLength !== undefined) {
    validators.push({ kind: "maxLength", argument: String(maxLength) });
  }

  const minItems = getMinItems(program, target);
  if (minItems !== undefined) {
    validators.push({ kind: "minItems", argument: String(minItems) });
  }

  const maxItems = getMaxItems(program, target);
  if (maxItems !== undefined) {
    validators.push({ kind: "maxItems", argument: String(maxItems) });
  }

  const pattern = getPatternData(program, target);
  if (pattern) {
    validators.push({
      kind: "pattern",
      argument: tsLiteral(pattern.pattern),
      message: pattern.validationMessage,
    });
  }

  return validators;
}

export function decodedTypeKind(ctx: EmitterCtx, type: Type): DecodedTypeKind {
  switch (type.kind) {
    case "Scalar": {
      const ts = scalarToTs(type, getDateTimeMode(ctx));
      if (ts === "number" || ts === "bigint" || ts === "string") return ts;
      if (ts === "Uint8Array") return "bytes";
      return "other";
    }
    case "Model":
      return isArrayModelType(ctx.program, type) ? "array" : "other";
    case "Tuple":
      return "array";
    case "ModelProperty":
      return decodedTypeKind(ctx, type.type);
    case "String":
    case "StringTemplate":
      return "string";
    case "Number":
      return "number";
    default:
      return "other";
  }
}

function emitNumericValue(value: Numeric, preferBigInt: boolean): string {
  if (preferBigInt && value.isInteger) {
    return `${value.toString()}n`;
  }

  const numberValue = value.asNumber();
  return numberValue === null ? `Number(${tsLiteral(value.toString())})` : String(numberValue);
}
