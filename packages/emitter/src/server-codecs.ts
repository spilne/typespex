import type { HttpOperation } from "@typespec/http";
import type {
  Enum,
  Model,
  Scalar,
  Type,
  Union,
} from "@typespec/compiler";
import {
  isArrayModelType,
  isRecordModelType,
} from "@typespec/compiler";
import type { EmitterCtx } from "./ctx.js";
import { buildInputType } from "./emit-server-common.js";
import { scalarToTs } from "./scalar-map.js";
import { typeToTs } from "./type-reference.js";

type CodecMode = "json" | "text";

const SERVER_CODEC_IMPORTS = [
  "arrayCodec",
  "bigintCodec",
  "booleanCodec",
  "bytesCodec",
  "decodeFields",
  "decodeFieldsAndBody",
  "decodeJsonBody",
  "literalCodec",
  "strictLiteralCodec",
  "mapFieldDecoder",
  "mapNFields",
  "numberCodec",
  "objectCodec",
  "optional",
  "optionalHeader",
  "optionalQuery",
  "recordCodec",
  "requiredHeader",
  "requiredPath",
  "requiredQuery",
  "strictArrayCodec",
  "stringCodec",
  "tupleCodec",
  "unionCodec",
  "unknownCodec",
] as const;

export function getServerCodecImports(): readonly string[] {
  return SERVER_CODEC_IMPORTS;
}

/** One property entry inside a group's Codecs object. */
export interface CodecEntry {
  /** Pre-formatted lines (2-space indented) for the object body. */
  readonly lines: readonly string[];
}

/** Result of emitting one operation's decoder. */
export interface DecoderEmission {
  /** Entries for the group's Codecs object. */
  readonly codecEntries: readonly CodecEntry[];
  /** The decode expression (used as arrow body). */
  readonly decodeExpression: string;
  /** Whether decodeInput needs pathParams in its signature. */
  readonly needsPathParams: boolean;
  /** Whether decodeInput is async (body involved). */
  readonly isAsync: boolean;
}

/**
 * Emits the decoder for one HTTP operation.
 * Returns codec entries (for the group's Codecs object) and a decode expression.
 */
export function emitDecoder(
  ctx: EmitterCtx,
  op: HttpOperation,
  codecsRef: string,
  opName: string,
): DecoderEmission {
  const pathParams = op.parameters.parameters.filter((p) => p.type === "path");
  const queryParams = op.parameters.parameters.filter((p) => p.type === "query");
  const headerParams = op.parameters.parameters.filter((p) => p.type === "header");
  const hasBody = op.parameters.body != null;
  const hasFields = pathParams.length + queryParams.length + headerParams.length > 0;
  const inputType = buildInputType(ctx, op);

  // Build field decoder entries
  const fieldEntries: Array<{ name: string; expr: string }> = [];
  for (const param of pathParams) {
    fieldEntries.push({
      name: param.param.name,
      expr: `requiredPath(${JSON.stringify(param.param.name)}, ${emitCodecExpression(ctx, param.param.type, "text")})`,
    });
  }
  for (const param of queryParams) {
    const fn = param.param.optional ? "optionalQuery" : "requiredQuery";
    fieldEntries.push({
      name: param.param.name,
      expr: `${fn}(${JSON.stringify(param.name)}, ${emitCodecExpression(ctx, param.param.type, "text")})`,
    });
  }
  for (const param of headerParams) {
    const fn = param.param.optional ? "optionalHeader" : "requiredHeader";
    fieldEntries.push({
      name: param.param.name,
      expr: `${fn}(${JSON.stringify(param.name.toLowerCase())}, ${emitCodecExpression(ctx, param.param.type, "text")})`,
    });
  }

  // Case 1: no params, no body — sync, returns Right directly
  if (!hasFields && !hasBody) {
    return {
      codecEntries: [],
      decodeExpression: `Either.right({} as Record<string, never>)`,
      needsPathParams: false,
      isAsync: false,
    };
  }

  // Case 2: fields only — sync Either
  if (hasFields && !hasBody) {
    const ref = `${codecsRef}.${opName}`;
    return {
      codecEntries: [emitFieldDecoderEntry(opName, fieldEntries)],
      decodeExpression: `decodeFields<${inputType}>(${ref}, request, pathParams)`,
      needsPathParams: true,
      isAsync: false,
    };
  }

  // Case 3: body only — async Either
  if (!hasFields && hasBody) {
    const ref = `${codecsRef}.${opName}`;
    return {
      codecEntries: [emitBodyCodecEntry(opName, ctx, op)],
      decodeExpression: `decodeJsonBody<${inputType}>(request, ${ref})`,
      needsPathParams: false,
      isAsync: true,
    };
  }

  // Case 4: fields + body — async Either with error accumulation
  const fieldsRef = `${codecsRef}.${opName}Fields`;
  const bodyRef = `${codecsRef}.${opName}Body`;
  const bodyType = typeToTs(ctx, op.parameters.body!.type);
  const fieldsType = buildFieldsOnlyType(ctx, op);
  return {
    codecEntries: [
      emitFieldDecoderEntry(`${opName}Fields`, fieldEntries),
      emitBodyCodecEntry(`${opName}Body`, ctx, op),
    ],
    decodeExpression: `decodeFieldsAndBody<${fieldsType}, ${bodyType}>(${fieldsRef}, ${bodyRef}, request, pathParams)`,
    needsPathParams: true,
    isAsync: true,
  };
}

// ---------------------------------------------------------------------------
// Codec entry formatting (pre-indented for inside the Codecs object)
// ---------------------------------------------------------------------------

function emitFieldDecoderEntry(
  name: string,
  entries: ReadonlyArray<{ name: string; expr: string }>,
): CodecEntry {
  const lines: string[] = [];
  if (entries.length === 1) {
    const [e] = entries;
    lines.push(`  ${name}: mapFieldDecoder(`);
    lines.push(`    ${e.expr},`);
    lines.push(`    (${e.name}) => ({ ${e.name} }),`);
    lines.push(`  ),`);
  } else {
    const decoders = entries.map((e) => e.expr).join(", ");
    const args = entries.map((e) => e.name).join(", ");
    lines.push(`  ${name}: mapNFields(`);
    lines.push(`    [${decoders}],`);
    lines.push(`    (${args}) => ({ ${args} }),`);
    lines.push(`  ),`);
  }
  return { lines };
}

function emitBodyCodecEntry(
  name: string,
  ctx: EmitterCtx,
  op: HttpOperation,
): CodecEntry {
  const lines: string[] = [];
  const bodyType = op.parameters.body!.type;

  // Multi-line for object types
  if (bodyType.kind === "Model" && !isArrayModelType(ctx.program, bodyType) && !isRecordModelType(ctx.program, bodyType)) {
    const tsType = typeToTs(ctx, bodyType);
    lines.push(`  ${name}: objectCodec<${tsType}>({`);
    for (const prop of bodyType.properties.values()) {
      const fieldCodec = emitCodecExpression(ctx, prop.type, "json");
      const expr = prop.optional ? `optional(${fieldCodec})` : fieldCodec;
      lines.push(`    ${JSON.stringify(prop.name)}: ${expr},`);
    }
    lines.push(`  }),`);
  } else {
    const codecExpr = emitCodecExpression(ctx, bodyType, "json");
    lines.push(`  ${name}: ${codecExpr},`);
  }
  return { lines };
}

// ---------------------------------------------------------------------------
// Inline codec expression emission (single-line)
// ---------------------------------------------------------------------------

function buildFieldsOnlyType(ctx: EmitterCtx, op: HttpOperation): string {
  const parts: string[] = [];
  for (const param of op.parameters.parameters) {
    const optional = param.param.optional ? "?" : "";
    parts.push(`${param.param.name}${optional}: ${typeToTs(ctx, param.param.type)}`);
  }
  if (parts.length === 0) return "Record<string, never>";
  return `{ ${parts.join("; ")} }`;
}

function emitCodecExpression(
  ctx: EmitterCtx,
  type: Type,
  mode: CodecMode,
  seenModels: ReadonlySet<string> = new Set(),
): string {
  switch (type.kind) {
    case "Scalar":
      return emitScalarCodec(type, mode);

    case "Model":
      if (isArrayModelType(ctx.program, type)) {
        const arrayFn = mode === "json" ? "strictArrayCodec" : "arrayCodec";
        return `${arrayFn}(${emitCodecExpression(ctx, type.indexer!.value, mode, seenModels)})`;
      }
      if (isRecordModelType(ctx.program, type)) {
        return `recordCodec(${emitCodecExpression(ctx, type.indexer!.value, mode, seenModels)})`;
      }
      return emitObjectCodec(ctx, type, mode, seenModels);

    case "Union":
      return emitUnionCodec(ctx, type, mode, seenModels);

    case "Enum":
      return emitEnumCodec(type, mode);

    case "String": {
      const lit = mode === "json" ? "strictLiteralCodec" : "literalCodec";
      return `${lit}(${JSON.stringify(type.value)})`;
    }

    case "Number": {
      const lit = mode === "json" ? "strictLiteralCodec" : "literalCodec";
      return `${lit}(${String(type.value)})`;
    }

    case "Boolean": {
      const lit = mode === "json" ? "strictLiteralCodec" : "literalCodec";
      return `${lit}(${String(type.value)})`;
    }

    case "Intrinsic":
      switch (type.name) {
        case "null": {
          const lit = mode === "json" ? "strictLiteralCodec" : "literalCodec";
          return `${lit}(null)`;
        }
        case "unknown":
          return "unknownCodec";
        default:
          return "unknownCodec";
      }

    case "Tuple":
      return `tupleCodec<${typeToTs(ctx, type)}>([${type.values
        .map((value) => emitCodecExpression(ctx, value, mode, seenModels))
        .join(", ")}])`;

    case "UnionVariant":
      return emitCodecExpression(ctx, type.type, mode, seenModels);

    case "ModelProperty":
      return emitCodecExpression(ctx, type.type, mode, seenModels);

    default:
      return "unknownCodec";
  }
}

function emitScalarCodec(scalar: Scalar, mode: CodecMode): string {
  switch (scalarToTs(scalar)) {
    case "number": return "numberCodec";
    case "bigint": return "bigintCodec";
    case "string": return "stringCodec";
    case "boolean": return "booleanCodec";
    case "Uint8Array": return "bytesCodec";
    default: return mode === "text" ? "stringCodec" : "unknownCodec";
  }
}

function emitObjectCodec(
  ctx: EmitterCtx,
  model: Model,
  mode: CodecMode,
  seenModels: ReadonlySet<string>,
): string {
  if (mode === "text") return "unknownCodec";

  const modelName = typeof model.name === "string" && model.name !== ""
    ? model.name
    : undefined;
  if (modelName && seenModels.has(modelName)) return "unknownCodec";

  const nextSeen = modelName ? new Set([...seenModels, modelName]) : seenModels;

  const fields = [...model.properties.values()]
    .map((prop) => {
      const fieldCodec = emitCodecExpression(ctx, prop.type, mode, nextSeen);
      const expr = prop.optional ? `optional(${fieldCodec})` : fieldCodec;
      return `${JSON.stringify(prop.name)}: ${expr}`;
    })
    .join(", ");

  return `objectCodec<${typeToTs(ctx, model)}>({ ${fields} })`;
}

function emitUnionCodec(
  ctx: EmitterCtx,
  union: Union,
  mode: CodecMode,
  seenModels: ReadonlySet<string>,
): string {
  const variants = [...union.variants.values()]
    .map((variant) => emitCodecExpression(ctx, variant.type, mode, seenModels))
    .join(", ");
  return `unionCodec<${typeToTs(ctx, union)}>([${variants}])`;
}

function emitEnumCodec(enumType: Enum, mode: CodecMode): string {
  const lit = mode === "json" ? "strictLiteralCodec" : "literalCodec";
  const members = [...enumType.members.values()].map((member) => {
    const value = member.value ?? member.name;
    return `${lit}(${JSON.stringify(value)})`;
  });
  return `unionCodec([${members.join(", ")}])`;
}
