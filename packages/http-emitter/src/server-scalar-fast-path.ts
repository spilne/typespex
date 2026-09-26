import type { ModelProperty, Scalar } from "@typespec/compiler";
import { isHeader } from "@typespec/http";
import type { EmitterCtx } from "./ctx.js";
import { resolveScalarEncoding } from "./scalar-encoding.js";
import { scalarIntegerRange } from "./scalar-integer-ranges.js";
import { getIntrinsicScalarName } from "./scalar-map.js";
import type { DecoderMode } from "./server-value-decoders.js";
import { getValidationRules, type ValidationRule } from "./validation-emission.js";

/** Inline successful scalar validation; retain the staged decoder for exact diagnostics. */
export function emitScalarFastPath(
  ctx: EmitterCtx,
  scalar: Scalar,
  target: ModelProperty | undefined,
  encodingTarget: ModelProperty | undefined,
  mode: DecoderMode,
  fallback: string,
): string {
  const intrinsic = getIntrinsicScalarName(scalar);
  const string = intrinsic === "string";
  const range = scalarIntegerRange(intrinsic);
  const integer =
    intrinsic === "integer" ||
    intrinsic === "safeint" ||
    (range !== undefined && intrinsic !== "int64" && intrinsic !== "uint64");
  if (!string && !integer) return fallback;
  const context =
    mode === "binary"
      ? "binary"
      : encodingTarget && isHeader(ctx.program, encodingTarget)
        ? "header"
        : "value";
  if (resolveScalarEncoding(ctx, scalar, encodingTarget, context).status !== "none")
    return fallback;
  const kind = string ? "string" : "number";
  const rules = [
    ...getValidationRules(ctx, scalar, kind),
    ...(target ? getValidationRules(ctx, target, kind) : []),
  ];
  if (!range && rules.length === 0) return fallback;

  const value = string ? "input" : "decoded.right";
  const declarations: string[] = [];
  const conditions = range ? [`${value} >= ${range[0]}`, `${value} <= ${range[1]}`] : [];
  for (const rule of rules) {
    if (
      string &&
      ["minValue", "maxValue", "minValueExclusive", "maxValueExclusive"].includes(rule.kind)
    )
      return fallback;
    if (
      !string &&
      ["minLength", "maxLength", "minItems", "maxItems", "pattern"].includes(rule.kind)
    )
      return fallback;
    conditions.push(validationCondition(rule, value, declarations));
  }
  const strict = mode === "json" || mode === "binary";
  const decoder =
    intrinsic === "safeint"
      ? strict
        ? "Decoders.strictSafeInteger"
        : "Decoders.safeInteger"
      : strict
        ? "Decoders.strictInteger"
        : "Decoders.integer";
  return `(() => {
    const fallback = ${fallback};
    ${declarations.join("\n")}
    return Decoder.of<${kind}>((input) => {
      ${string ? "" : `const decoded = ${decoder}.decode(input);\nif (decoded._tag === "Left") return decoded;`}
      if (${[...(string ? ['typeof input === "string"'] : []), ...conditions].join(" && ")}) {
        return ${string ? "Either.right(input)" : "decoded"};
      }
      return fallback.decode(input);
    });
  })()`;
}

/**
 * A strict JSON check for a scalar type, with the rules of the optional
 * target property and the encoding of the optional encoding target. Strings,
 * integers, numbers, and booleans are supported; encoded scalars and
 * unsupported rule combinations return undefined.
 */
export function emitStrictScalarTypeGuard(
  ctx: EmitterCtx,
  scalar: Scalar,
  target: ModelProperty | undefined,
  encodingTarget: ModelProperty | undefined,
  value: string,
  declarations: string[],
): string | undefined {
  const intrinsic = getIntrinsicScalarName(scalar);
  const range = scalarIntegerRange(intrinsic);
  const kind: "string" | "integer" | "number" | "boolean" | undefined =
    intrinsic === "string"
      ? "string"
      : intrinsic === "boolean"
        ? "boolean"
        : intrinsic === "integer" ||
            intrinsic === "safeint" ||
            (range !== undefined && intrinsic !== "int64" && intrinsic !== "uint64")
          ? "integer"
          : ["float32", "float64", "float", "numeric", "decimal", "decimal128"].includes(intrinsic)
            ? "number"
            : undefined;
  if (kind === undefined) return undefined;
  const context = encodingTarget && isHeader(ctx.program, encodingTarget) ? "header" : "value";
  if (resolveScalarEncoding(ctx, scalar, encodingTarget, context).status !== "none") {
    return undefined;
  }
  const conditions =
    kind === "string"
      ? [`typeof ${value} === "string"`]
      : kind === "boolean"
        ? [`typeof ${value} === "boolean"`]
        : kind === "integer"
          ? [`typeof ${value} === "number"`, `Number.isSafeInteger(${value})`]
          : [`typeof ${value} === "number"`, `Number.isFinite(${value})`];
  if (range) conditions.push(`${value} >= ${range[0]}`, `${value} <= ${range[1]}`);
  const ruleKind = kind === "string" ? "string" : "number";
  for (const rule of [
    ...getValidationRules(ctx, scalar, ruleKind),
    ...(target ? getValidationRules(ctx, target, ruleKind) : []),
  ]) {
    if (kind === "boolean") return undefined;
    if (
      kind === "string"
        ? ["minValue", "maxValue", "minValueExclusive", "maxValueExclusive"].includes(rule.kind)
        : ["minLength", "maxLength", "minItems", "maxItems", "pattern"].includes(rule.kind)
    ) {
      return undefined;
    }
    conditions.push(validationCondition(rule, value, declarations));
  }
  return conditions.join(" && ");
}

function validationCondition(rule: ValidationRule, value: string, declarations: string[]): string {
  switch (rule.kind) {
    case "minValue":
      return `${value} >= ${rule.argument}`;
    case "maxValue":
      return `${value} <= ${rule.argument}`;
    case "minValueExclusive":
      return `${value} > ${rule.argument}`;
    case "maxValueExclusive":
      return `${value} < ${rule.argument}`;
    case "minLength":
    case "minItems":
      return `${value}.length >= ${rule.argument}`;
    case "maxLength":
    case "maxItems":
      return `${value}.length <= ${rule.argument}`;
    case "pattern": {
      const name = `pattern${declarations.length}`;
      declarations.push(`const ${name} = new RegExp(${rule.argument});`);
      return `${name}.test(${value})`;
    }
  }
}
