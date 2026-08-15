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

/** Runtime validators declared directly on a TypeSpec type. */
export function emitValidatorsForTarget(
  ctx: EmitterCtx,
  target: Type,
  kind: DecodedTypeKind,
): string[] {
  const program = ctx.program;
  const validators: string[] = [];

  const minValue = getMinValueAsNumeric(program, target);
  if (minValue) {
    validators.push(`Validators.minValue(${emitNumericValue(minValue, kind === "bigint")})`);
  }

  const maxValue = getMaxValueAsNumeric(program, target);
  if (maxValue) {
    validators.push(`Validators.maxValue(${emitNumericValue(maxValue, kind === "bigint")})`);
  }

  const minValueExclusive = getMinValueExclusiveAsNumeric(program, target);
  if (minValueExclusive) {
    validators.push(
      `Validators.minValueExclusive(${emitNumericValue(minValueExclusive, kind === "bigint")})`,
    );
  }

  const maxValueExclusive = getMaxValueExclusiveAsNumeric(program, target);
  if (maxValueExclusive) {
    validators.push(
      `Validators.maxValueExclusive(${emitNumericValue(maxValueExclusive, kind === "bigint")})`,
    );
  }

  const minLength = getMinLength(program, target);
  if (minLength !== undefined) {
    validators.push(`Validators.minLength(${minLength})`);
  }

  const maxLength = getMaxLength(program, target);
  if (maxLength !== undefined) {
    validators.push(`Validators.maxLength(${maxLength})`);
  }

  const minItems = getMinItems(program, target);
  if (minItems !== undefined) {
    validators.push(`Validators.minItems(${minItems})`);
  }

  const maxItems = getMaxItems(program, target);
  if (maxItems !== undefined) {
    validators.push(`Validators.maxItems(${maxItems})`);
  }

  const pattern = getPatternData(program, target);
  if (pattern) {
    validators.push(
      `Validators.pattern(${tsLiteral(pattern.pattern)}${pattern.validationMessage ? `, ${tsLiteral(pattern.validationMessage)}` : ""})`,
    );
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
