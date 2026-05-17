import type { HttpOperation } from "@typespec/http";
import type {
  Enum,
  Model,
  ModelProperty,
  Numeric,
  Scalar,
  Type,
  Union,
} from "@typespec/compiler";
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
  isRecordModelType,
} from "@typespec/compiler";
import type { EmitterCtx } from "./ctx.js";
import { buildInputType } from "./emit-server-common.js";
import { scalarToTs } from "./scalar-map.js";
import { typeToTs } from "./type-reference.js";

type DecoderMode = "json" | "text";

const SERVER_INPUT_DECODER_IMPORTS = [
  "Decoders",
  "RequestDecoders",
  "Validators",
  "decodeRequestInput",
  "decodeRequestInputAndBody",
  "decodeJsonBody",
] as const;

export function getServerInputDecoderImports(): readonly string[] {
  return SERVER_INPUT_DECODER_IMPORTS;
}

/** One property entry inside a group's input decoder object. */
export interface InputDecoderEntry {
  /** Pre-formatted lines (2-space indented) for the object body. */
  readonly lines: readonly string[];
}

/** Result of emitting one operation's decoder. */
export interface DecoderEmission {
  /** Entries for the group's input decoder object. */
  readonly inputEntries: readonly InputDecoderEntry[];
  /** The decode expression (used as arrow body). */
  readonly decodeExpression: string;
  /** Whether decodeInput needs pathParams in its signature. */
  readonly needsPathParams: boolean;
  /** Whether decodeInput is async (body involved). */
  readonly isAsync: boolean;
}

/**
 * Emits the decoder for one HTTP operation.
 * Returns input decoder entries and a decode expression.
 */
export function emitDecoder(
  ctx: EmitterCtx,
  op: HttpOperation,
  inputsRef: string,
  opName: string,
): DecoderEmission {
  const pathParams = op.parameters.parameters.filter((p) => p.type === "path");
  const queryParams = op.parameters.parameters.filter((p) => p.type === "query");
  const headerParams = op.parameters.parameters.filter((p) => p.type === "header");
  const cookieParams = op.parameters.parameters.filter((p) => p.type === "cookie");
  const hasBody = op.parameters.body != null;
  const hasRequestInput = pathParams.length + queryParams.length + headerParams.length + cookieParams.length > 0;
  const inputType = buildInputType(ctx, op);

  // Build request input decoder entries.
  const requestEntries: Array<{ name: string; expr: string }> = [];
  for (const param of pathParams) {
    requestEntries.push({
      name: param.param.name,
      expr: `RequestDecoders.path(${JSON.stringify(param.param.name)}, ${emitDecoderExpression(ctx, param.param.type, "text", new Set(), param.param)})`,
    });
  }
  for (const param of queryParams) {
    const valueDecoder = emitDecoderExpression(ctx, param.param.type, "text", new Set(), param.param);
    const decoder = param.param.optional ? `${valueDecoder}.optional()` : valueDecoder;
    requestEntries.push({
      name: param.param.name,
      expr: `RequestDecoders.query(${JSON.stringify(param.name)}, ${decoder})`,
    });
  }
  for (const param of headerParams) {
    const valueDecoder = emitDecoderExpression(ctx, param.param.type, "text", new Set(), param.param);
    const decoder = param.param.optional ? `${valueDecoder}.optional()` : valueDecoder;
    requestEntries.push({
      name: param.param.name,
      expr: `RequestDecoders.header(${JSON.stringify(param.name.toLowerCase())}, ${decoder})`,
    });
  }
  for (const param of cookieParams) {
    const valueDecoder = emitDecoderExpression(ctx, param.param.type, "text", new Set(), param.param);
    const decoder = param.param.optional ? `${valueDecoder}.optional()` : valueDecoder;
    requestEntries.push({
      name: param.param.name,
      expr: `RequestDecoders.cookie(${JSON.stringify(param.name)}, ${decoder})`,
    });
  }

  // Case 1: no params, no body — sync, returns Right directly
  if (!hasRequestInput && !hasBody) {
    return {
      inputEntries: [],
      decodeExpression: `Either.right({} as Record<string, never>)`,
      needsPathParams: false,
      isAsync: false,
    };
  }

  // Case 2: request input only — sync Either
  if (hasRequestInput && !hasBody) {
    const ref = `${inputsRef}.${opName}`;
    return {
      inputEntries: [emitRequestDecoderEntry(opName, requestEntries)],
      decodeExpression: `decodeRequestInput<${inputType}>(${ref}, request, pathParams)`,
      needsPathParams: true,
      isAsync: false,
    };
  }

  // Case 3: body only — async Either
  if (!hasRequestInput && hasBody) {
    const ref = `${inputsRef}.${opName}`;
    return {
      inputEntries: [emitBodyDecoderEntry(opName, ctx, op)],
      decodeExpression: `decodeJsonBody<${inputType}>(request, ${ref})`,
      needsPathParams: false,
      isAsync: true,
    };
  }

  // Case 4: request input + body — async Either with error accumulation
  const requestRef = `${inputsRef}.${opName}Request`;
  const bodyRef = `${inputsRef}.${opName}Body`;
  const bodyType = typeToTs(ctx, op.parameters.body!.type);
  const requestType = buildRequestOnlyType(ctx, op);
  return {
    inputEntries: [
      emitRequestDecoderEntry(`${opName}Request`, requestEntries),
      emitBodyDecoderEntry(`${opName}Body`, ctx, op),
    ],
    decodeExpression: `decodeRequestInputAndBody<${requestType}, ${bodyType}>(${requestRef}, ${bodyRef}, request, pathParams)`,
    needsPathParams: true,
    isAsync: true,
  };
}

// ---------------------------------------------------------------------------
// Input decoder entry formatting (pre-indented for inside the input object)
// ---------------------------------------------------------------------------

function emitRequestDecoderEntry(
  name: string,
  entries: ReadonlyArray<{ name: string; expr: string }>,
): InputDecoderEntry {
  const lines: string[] = [];
  if (entries.length === 1) {
    const [e] = entries;
    lines.push(`  ${name}: ${e.expr}.map((${e.name}) => ({ ${e.name} })),`);
  } else {
    const decoders = entries.map((e) => e.expr).join(", ");
    const args = entries.map((e) => e.name).join(", ");
    lines.push(`  ${name}: RequestDecoders.combine(`);
    lines.push(`    [${decoders}],`);
    lines.push(`    (${args}) => ({ ${args} }),`);
    lines.push(`  ),`);
  }
  return { lines };
}

function emitBodyDecoderEntry(
  name: string,
  ctx: EmitterCtx,
  op: HttpOperation,
): InputDecoderEntry {
  const lines: string[] = [];
  const bodyType = op.parameters.body!.type;

  // Multi-line for object types
  if (bodyType.kind === "Model" && !isArrayModelType(ctx.program, bodyType) && !isRecordModelType(ctx.program, bodyType)) {
    const tsType = typeToTs(ctx, bodyType);
    lines.push(`  ${name}: Decoders.object<${tsType}>({`);
    for (const prop of bodyType.properties.values()) {
      const propertyDecoder = emitDecoderExpression(ctx, prop.type, "json", new Set(), prop);
      const expr = prop.optional ? `Decoders.optional(${propertyDecoder})` : propertyDecoder;
      lines.push(`    ${JSON.stringify(prop.name)}: ${expr},`);
    }
    lines.push(`  }),`);
  } else {
    const decoderExpr = emitDecoderExpression(ctx, bodyType, "json");
    lines.push(`  ${name}: ${decoderExpr},`);
  }
  return { lines };
}

// ---------------------------------------------------------------------------
// Inline decoder expression emission (single-line)
// ---------------------------------------------------------------------------

function buildRequestOnlyType(ctx: EmitterCtx, op: HttpOperation): string {
  const parts: string[] = [];
  for (const param of op.parameters.parameters) {
    const optional = param.param.optional ? "?" : "";
    parts.push(`${param.param.name}${optional}: ${typeToTs(ctx, param.param.type)}`);
  }
  if (parts.length === 0) return "Record<string, never>";
  return `{ ${parts.join("; ")} }`;
}

function emitDecoderExpression(
  ctx: EmitterCtx,
  type: Type,
  mode: DecoderMode,
  seenModels: ReadonlySet<string> = new Set(),
  target?: ModelProperty,
): string {
  let expression: string;
  switch (type.kind) {
    case "Scalar":
      expression = emitScalarDecoder(type, mode);
      break;

    case "Model":
      if (isArrayModelType(ctx.program, type)) {
        const arrayFn = mode === "json" ? "Decoders.strictArray" : "Decoders.array";
        expression = `${arrayFn}(${emitDecoderExpression(ctx, type.indexer!.value, mode, seenModels)})`;
        break;
      }
      if (isRecordModelType(ctx.program, type)) {
        expression = `Decoders.record(${emitDecoderExpression(ctx, type.indexer!.value, mode, seenModels)})`;
        break;
      }
      expression = emitObjectDecoder(ctx, type, mode, seenModels);
      break;

    case "Union":
      expression = emitUnionDecoder(ctx, type, mode, seenModels);
      break;

    case "Enum":
      expression = emitEnumDecoder(type, mode);
      break;

    case "String": {
      const lit = mode === "json" ? "Decoders.strictLiteral" : "Decoders.literal";
      expression = `${lit}(${JSON.stringify(type.value)})`;
      break;
    }

    case "Number": {
      const lit = mode === "json" ? "Decoders.strictLiteral" : "Decoders.literal";
      expression = `${lit}(${String(type.value)})`;
      break;
    }

    case "Boolean": {
      const lit = mode === "json" ? "Decoders.strictLiteral" : "Decoders.literal";
      expression = `${lit}(${String(type.value)})`;
      break;
    }

    case "Intrinsic":
      switch (type.name) {
        case "null": {
          const lit = mode === "json" ? "Decoders.strictLiteral" : "Decoders.literal";
          expression = `${lit}(null)`;
          break;
        }
        case "unknown":
          expression = "Decoders.unknown";
          break;
        default:
          expression = "Decoders.unknown";
          break;
      }
      break;

    case "Tuple":
      expression = `Decoders.tuple<${typeToTs(ctx, type)}>([${type.values
        .map((value) => emitDecoderExpression(ctx, value, mode, seenModels))
        .join(", ")}])`;
      break;

    case "UnionVariant":
      expression = emitDecoderExpression(ctx, type.type, mode, seenModels);
      break;

    case "ModelProperty":
      return emitDecoderExpression(ctx, type.type, mode, seenModels, type);

    default:
      expression = "Decoders.unknown";
      break;
  }

  return applyValidationDecorators(ctx, expression, type, target);
}

function emitScalarDecoder(scalar: Scalar, mode: DecoderMode): string {
  switch (scalarToTs(scalar)) {
    case "number": return "Decoders.number";
    case "bigint": return "Decoders.bigint";
    case "string": return "Decoders.string";
    case "boolean": return "Decoders.boolean";
    case "Uint8Array": return "Decoders.bytes";
    default: return mode === "text" ? "Decoders.string" : "Decoders.unknown";
  }
}

function emitObjectDecoder(
  ctx: EmitterCtx,
  model: Model,
  mode: DecoderMode,
  seenModels: ReadonlySet<string>,
): string {
  if (mode === "text") return "Decoders.unknown";

  const modelName = typeof model.name === "string" && model.name !== ""
    ? model.name
    : undefined;
  if (modelName && seenModels.has(modelName)) return "Decoders.unknown";

  const nextSeen = modelName ? new Set([...seenModels, modelName]) : seenModels;

  const fields = [...model.properties.values()]
    .map((prop) => {
      const propertyDecoder = emitDecoderExpression(ctx, prop.type, mode, nextSeen, prop);
      const expr = prop.optional ? `Decoders.optional(${propertyDecoder})` : propertyDecoder;
      return `${JSON.stringify(prop.name)}: ${expr}`;
    })
    .join(", ");

  return `Decoders.object<${typeToTs(ctx, model)}>({ ${fields} })`;
}

function emitUnionDecoder(
  ctx: EmitterCtx,
  union: Union,
  mode: DecoderMode,
  seenModels: ReadonlySet<string>,
): string {
  const variants = [...union.variants.values()]
    .map((variant) => emitDecoderExpression(ctx, variant.type, mode, seenModels))
    .join(", ");
  return `Decoders.union<${typeToTs(ctx, union)}>([${variants}])`;
}

function emitEnumDecoder(enumType: Enum, mode: DecoderMode): string {
  const lit = mode === "json" ? "Decoders.strictLiteral" : "Decoders.literal";
  const members = [...enumType.members.values()].map((member) => {
    const value = member.value ?? member.name;
    return `${lit}(${JSON.stringify(value)})`;
  });
  return `Decoders.union([${members.join(", ")}])`;
}

function applyValidationDecorators(
  ctx: EmitterCtx,
  expression: string,
  type: Type,
  target?: ModelProperty,
): string {
  const validators = [
    ...emitValidatorsForTarget(ctx, type, decodedTypeKind(ctx, type)),
    ...(target ? emitValidatorsForTarget(ctx, target, decodedTypeKind(ctx, target.type)) : []),
  ];

  if (validators.length === 0) return expression;
  return `${expression}.validate(${validators.join(", ")})`;
}

function emitValidatorsForTarget(
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
    validators.push(`Validators.minValueExclusive(${emitNumericValue(minValueExclusive, kind === "bigint")})`);
  }

  const maxValueExclusive = getMaxValueExclusiveAsNumeric(program, target);
  if (maxValueExclusive) {
    validators.push(`Validators.maxValueExclusive(${emitNumericValue(maxValueExclusive, kind === "bigint")})`);
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
    validators.push(`Validators.pattern(${JSON.stringify(pattern.pattern)}${pattern.validationMessage ? `, ${JSON.stringify(pattern.validationMessage)}` : ""})`);
  }

  return validators;
}

type DecodedTypeKind = "number" | "bigint" | "string" | "bytes" | "array" | "other";

function decodedTypeKind(ctx: EmitterCtx, type: Type): DecodedTypeKind {
  switch (type.kind) {
    case "Scalar": {
      const ts = scalarToTs(type);
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
  return numberValue === null ? `Number(${JSON.stringify(value.toString())})` : String(numberValue);
}
