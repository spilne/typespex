/**
 * Emits a direct reader for operations whose only inputs are flat scalar query
 * parameters. Ordinary values are read from the raw query in one pass; any
 * unusual spelling or failed check defers to the generic decoder so
 * diagnostics, percent-decoding, and duplicate handling stay identical.
 */
import type { HttpOperationParameter } from "@typespec/http";
import type { Scalar } from "@typespec/compiler";
import type { EmitterCtx } from "./ctx.js";
import { getExplodedQueryModelProperties, isExplodedQueryRecord } from "./http-parameter-shapes.js";
import { resolveScalarEncoding } from "./scalar-encoding.js";
import { scalarIntegerRange } from "./scalar-integer-ranges.js";
import { getIntrinsicScalarName } from "./scalar-map.js";
import { tsLiteral, tsObjectKey } from "./typescript-names.js";
import { getValidationRules, type ValidationRule } from "./validation-emission.js";

type QueryScalarKind = "string" | "integer" | "number" | "boolean";

interface QueryField {
  readonly property: string;
  readonly wireName: string;
  readonly optional: boolean;
  readonly kind: QueryScalarKind;
  readonly conditions: readonly string[];
}

const INTEGER_TEXT = String.raw`/^-?(?:0|[1-9]\d*)$/`;
const NUMBER_TEXT = String.raw`/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/`;

/** Query names that the raw scan can compare without percent-decoding. */
const PLAIN_QUERY_NAME = /^[A-Za-z0-9_.~-]+$/;

export function emitFlatQueryDecoder(
  ctx: EmitterCtx,
  parameters: readonly HttpOperationParameter[],
  fallback: string,
  typeTs: string,
): string | undefined {
  if (parameters.length === 0) return undefined;
  const declarations: string[] = [];
  const fields: QueryField[] = [];
  for (const parameter of parameters) {
    const field = queryField(ctx, parameter, declarations);
    if (!field) return undefined;
    fields.push(field);
  }
  if (new Set(fields.map((field) => field.wireName)).size !== fields.length) return undefined;

  const reads = fields.map((field, index) => {
    const value = `value${index}`;
    const checks = [...field.conditions];
    let convert: string;
    switch (field.kind) {
      case "integer":
        checks.unshift("Number.isSafeInteger(number)");
        convert = `if (!INTEGER_TEXT.test(text)) return fallback.decode(input);
          const number = Number(text);`;
        break;
      case "number":
        checks.unshift("Number.isFinite(number)");
        convert = `if (!NUMBER_TEXT.test(text)) return fallback.decode(input);
          const number = Number(text);`;
        break;
      case "boolean":
        convert = `if (text !== "true" && text !== "false") return fallback.decode(input);`;
        break;
      case "string":
        convert = `if (text.includes("%") || text.includes("+")) return fallback.decode(input);`;
        break;
    }
    const result =
      field.kind === "integer" || field.kind === "number"
        ? "number"
        : field.kind === "boolean"
          ? 'text === "true"'
          : "text";
    return `if (length === ${field.wireName.length} && raw.startsWith(${tsLiteral(field.wireName)}, start)) {
          if (${value} !== undefined) return fallback.decode(input);
          const text = equals === end ? "" : raw.substring(equals + 1, end);
          ${convert}
          ${checks.length > 0 ? `if (!(${checks.join(" && ")})) return fallback.decode(input);` : ""}
          ${value} = ${result};
        }`;
  });
  const required = fields
    .map((field, index) => (field.optional ? undefined : `value${index} === undefined`))
    .filter((check): check is string => check !== undefined);
  const output = fields
    .map((field, index) => `${tsObjectKey(field.property)}: value${index}`)
    .join(", ");

  const constants = [
    ...(fields.some((field) => field.kind === "integer")
      ? [`const INTEGER_TEXT = ${INTEGER_TEXT};`]
      : []),
    ...(fields.some((field) => field.kind === "number")
      ? [`const NUMBER_TEXT = ${NUMBER_TEXT};`]
      : []),
    ...declarations,
  ];
  return `(() => {
    const fallback = ${fallback};
    ${constants.join("\n")}
    return Decoder.of<${typeTs}, RequestInputSource>((input) => {
      const raw = input.rawQuery;
      ${fields.map((field, index) => `let value${index}: ${valueTs(field)} | undefined;`).join("\n")}
      if (raw !== undefined && raw !== "") {
        // Names are matched in place; an encoded name may spell a declared
        // parameter, so encoded spellings defer to the generic decoder.
        const encoded = raw.includes("%") || raw.includes("+");
        let start = 0;
        for (;;) {
          const ampersand = raw.indexOf("&", start);
          const end = ampersand === -1 ? raw.length : ampersand;
          let equals = raw.indexOf("=", start);
          if (equals === -1 || equals > end) equals = end;
          const length = equals - start;
          ${reads.join(" else ")} else if (encoded) {
            const percent = raw.indexOf("%", start);
            const plus = raw.indexOf("+", start);
            if ((percent !== -1 && percent < equals) || (plus !== -1 && plus < equals)) {
              return fallback.decode(input);
            }
          }
          if (ampersand === -1) break;
          start = ampersand + 1;
        }
      }
      ${required.length > 0 ? `if (${required.join(" || ")}) return fallback.decode(input);` : ""}
      return Either.right({ ${output} } as ${typeTs});
    });
  })()`;
}

function valueTs(field: QueryField): string {
  return field.kind === "integer" || field.kind === "number" ? "number" : field.kind;
}

function queryField(
  ctx: EmitterCtx,
  parameter: HttpOperationParameter,
  declarations: string[],
): QueryField | undefined {
  if (parameter.type !== "query") return undefined;
  if (!PLAIN_QUERY_NAME.test(parameter.name)) return undefined;
  if (getExplodedQueryModelProperties(ctx, parameter) || isExplodedQueryRecord(ctx, parameter)) {
    return undefined;
  }
  const property = parameter.param;
  if (property.type.kind !== "Scalar") return undefined;
  const scalar = property.type;
  const kind = queryScalarKind(scalar);
  if (!kind) return undefined;
  if (resolveScalarEncoding(ctx, scalar, property, "value").status !== "none") return undefined;

  const ruleKind = kind === "string" ? "string" : "number";
  const conditions: string[] = [];
  const range = scalarIntegerRange(getIntrinsicScalarName(scalar));
  if (range) conditions.push(`number >= ${range[0]}`, `number <= ${range[1]}`);
  for (const rule of [
    ...getValidationRules(ctx, scalar, ruleKind),
    ...getValidationRules(ctx, property, ruleKind),
  ]) {
    const condition = validationCondition(rule, kind, declarations);
    if (!condition) return undefined;
    conditions.push(condition);
  }
  return {
    property: property.name,
    wireName: parameter.name,
    optional: property.optional,
    kind,
    conditions,
  };
}

function queryScalarKind(scalar: Scalar): QueryScalarKind | undefined {
  const intrinsic = getIntrinsicScalarName(scalar);
  if (intrinsic === "int64" || intrinsic === "uint64") return undefined;
  if (scalarIntegerRange(intrinsic) || intrinsic === "integer" || intrinsic === "safeint") {
    return "integer";
  }
  switch (intrinsic) {
    case "float32":
    case "float64":
    case "float":
    case "numeric":
    case "decimal":
    case "decimal128":
      return "number";
    case "string":
    case "url":
      return "string";
    case "boolean":
      return "boolean";
    default:
      return undefined;
  }
}

function validationCondition(
  rule: ValidationRule,
  kind: QueryScalarKind,
  declarations: string[],
): string | undefined {
  switch (rule.kind) {
    case "minValue":
      return kind === "string" ? undefined : `number >= ${rule.argument}`;
    case "maxValue":
      return kind === "string" ? undefined : `number <= ${rule.argument}`;
    case "minValueExclusive":
      return kind === "string" ? undefined : `number > ${rule.argument}`;
    case "maxValueExclusive":
      return kind === "string" ? undefined : `number < ${rule.argument}`;
    case "minLength":
      return kind === "string" ? `text.length >= ${rule.argument}` : undefined;
    case "maxLength":
      return kind === "string" ? `text.length <= ${rule.argument}` : undefined;
    case "pattern": {
      if (kind !== "string") return undefined;
      const name = `pattern${declarations.length}`;
      declarations.push(`const ${name} = new RegExp(${rule.argument});`);
      return `${name}.test(text)`;
    }
    default:
      return undefined;
  }
}
