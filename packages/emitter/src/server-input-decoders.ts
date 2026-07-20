import type { HttpOperation } from "@typespec/http";
import type { Enum, Model, ModelProperty, Numeric, Scalar, Type, Union } from "@typespec/compiler";
import {
  getDiscriminator,
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
  walkPropertiesInherited,
} from "@typespec/compiler";
import { getBodyMediaKinds, type BodyMediaKind } from "./body-media-kinds.js";
import { getGeneratedTypeName, type EmitterCtx } from "./ctx.js";
import { buildInputType, shouldFlattenBodyType } from "./emit-server-common.js";
import { scalarToTs } from "./scalar-map.js";
import { typeToTs } from "./type-reference.js";
import {
  isTsIdentifier,
  tsIdentifier,
  tsObjectKey,
  tsPropertyAccess,
  tsPropertyDeclaration,
} from "./typescript-names.js";

type DecoderMode = "json" | "text" | "form" | "binary";

/** Tracks hoisted lazy decoders for recursive models during a single emitDecoder call. */
interface DecoderEmitContext {
  readonly scopeName: string;
  /** mode-qualified generated model name → hoisted lazy decoder. */
  readonly lazyDecoders: Map<string, LazyDecoderEmission>;
  /** Tracks which lazy decoders have been fully emitted (not just referenced). */
  readonly emittedLazy: Set<string>;
  /** Cumulative declarations returned by every hoisting pass. */
  readonly hoistedDecoderLines: string[];
}

interface LazyDecoderEmission {
  readonly model: Model;
  readonly modelName: string;
  readonly mode: DecoderMode;
  readonly varName: string;
}

function createDecoderEmitContext(operationName: string): DecoderEmitContext {
  const identifier = tsIdentifier(operationName, "Operation");
  return {
    scopeName: `${identifier[0]!.toUpperCase()}${identifier.slice(1)}`,
    lazyDecoders: new Map(),
    emittedLazy: new Set(),
    hoistedDecoderLines: [],
  };
}

const SERVER_INPUT_DECODER_IMPORTS = [
  "Decoders",
  "RequestDecoders",
  "Validators",
  "decodeRequestInput",
  "decodeRequestInputAndBody",
  "decodeBody",
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
  /** Hoisted lazy decoder declarations for recursive models. */
  readonly hoistedDecoders: readonly string[];
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
  const dec = createDecoderEmitContext(opName);
  const pathParams = op.parameters.parameters.filter((p) => p.type === "path");
  const queryParams = op.parameters.parameters.filter((p) => p.type === "query");
  const headerParams = op.parameters.parameters.filter((p) => p.type === "header");
  const cookieParams = op.parameters.parameters.filter((p) => p.type === "cookie");
  const hasBody = op.parameters.body != null;
  const hasRequestInput =
    pathParams.length + queryParams.length + headerParams.length + cookieParams.length > 0;
  const inputType = buildInputType(ctx, op);

  // Build request input decoder entries.
  const requestEntries: Array<{ name: string; expr: string }> = [];
  for (const param of pathParams) {
    const options = isArrayInputType(ctx, param.param.type) ? ", { array: true }" : "";
    requestEntries.push({
      name: param.param.name,
      expr: `RequestDecoders.path(${JSON.stringify(param.name)}, ${emitDecoderExpression(ctx, dec, param.param.type, "text", new Set(), param.param)}${options})`,
    });
  }
  for (const param of queryParams) {
    const valueDecoder = emitDecoderExpression(
      ctx,
      dec,
      param.param.type,
      "text",
      new Set(),
      param.param,
    );
    const decoder = param.param.optional ? `${valueDecoder}.optional()` : valueDecoder;
    const options = isArrayInputType(ctx, param.param.type)
      ? `, { array: true, explode: ${param.explode} }`
      : "";
    requestEntries.push({
      name: param.param.name,
      expr: `RequestDecoders.query(${JSON.stringify(param.name)}, ${decoder}${options})`,
    });
  }
  for (const param of headerParams) {
    const valueDecoder = emitDecoderExpression(
      ctx,
      dec,
      param.param.type,
      "text",
      new Set(),
      param.param,
    );
    const decoder = param.param.optional ? `${valueDecoder}.optional()` : valueDecoder;
    const optionValues: string[] = [];
    if (isArrayInputType(ctx, param.param.type)) optionValues.push("array: true");
    if (param.name.toLowerCase() === "content-type") optionValues.push("mediaType: true");
    const options = optionValues.length > 0 ? `, { ${optionValues.join(", ")} }` : "";
    requestEntries.push({
      name: param.param.name,
      expr: `RequestDecoders.header(${JSON.stringify(param.name.toLowerCase())}, ${decoder}${options})`,
    });
  }
  for (const param of cookieParams) {
    const valueDecoder = emitDecoderExpression(
      ctx,
      dec,
      param.param.type,
      "text",
      new Set(),
      param.param,
    );
    const decoder = param.param.optional ? `${valueDecoder}.optional()` : valueDecoder;
    const options = isArrayInputType(ctx, param.param.type) ? ", { array: true }" : "";
    requestEntries.push({
      name: param.param.name,
      expr: `RequestDecoders.cookie(${JSON.stringify(param.name)}, ${decoder}${options})`,
    });
  }

  const hoistedDecoders = buildHoistedDecoders(ctx, dec);

  // Case 1: no params, no body — sync, returns Right directly
  if (!hasRequestInput && !hasBody) {
    return {
      inputEntries: [],
      decodeExpression: `Either.right({} as Record<string, never>)`,
      needsPathParams: false,
      isAsync: false,
      hoistedDecoders,
    };
  }

  // Case 2: request input only — sync Either
  if (hasRequestInput && !hasBody) {
    const ref = tsPropertyAccess(inputsRef, opName);
    return {
      inputEntries: [emitRequestDecoderEntry(opName, requestEntries)],
      decodeExpression: `decodeRequestInput<${inputType}>(${ref}, request, pathParams)`,
      needsPathParams: true,
      isAsync: false,
      hoistedDecoders,
    };
  }

  const body = hasBody ? analyzeBody(op) : undefined;
  const bodyOptionsArg = body ? emitBodyOptionsArg(body) : "";

  // Case 3: body only — async Either
  if (!hasRequestInput && body) {
    const ref = tsPropertyAccess(inputsRef, opName);
    const bodyType = buildBodyOnlyType(ctx, op);
    return {
      inputEntries: [emitBodyDecoderEntry(opName, ctx, dec, op, body)],
      decodeExpression: `decodeBody<${bodyType}>(request, ${ref}${bodyOptionsArg})`,
      needsPathParams: false,
      isAsync: true,
      hoistedDecoders: buildHoistedDecoders(ctx, dec),
    };
  }

  // Case 4: request input + body — async Either with error accumulation
  const requestRef = tsPropertyAccess(inputsRef, `${opName}Request`);
  const bodyRef = tsPropertyAccess(inputsRef, `${opName}Body`);
  const bodyInputType = buildBodyInputType(ctx, op);
  const requestType = buildRequestOnlyType(ctx, op);
  return {
    inputEntries: [
      emitRequestDecoderEntry(`${opName}Request`, requestEntries),
      emitBodyDecoderEntry(`${opName}Body`, ctx, dec, op, body!, { wrapNonFlattenedBody: true }),
    ],
    decodeExpression: `decodeRequestInputAndBody<${requestType}, ${bodyInputType}>(${requestRef}, ${bodyRef}, request, pathParams${bodyOptionsArg})`,
    needsPathParams: true,
    isAsync: true,
    hoistedDecoders: buildHoistedDecoders(ctx, dec),
  };
}

/** Emits the trailing body decode options argument, or an empty string. */
function emitBodyOptionsArg(emission: BodyEmission): string {
  const options: string[] = [];
  if (emission.contentTypes.length > 0) {
    const literal = emission.contentTypes.map((ct) => JSON.stringify(ct)).join(", ");
    options.push(`contentTypes: [${literal}]`);
  }
  if (emission.optional) options.push("optional: true");
  return options.length > 0 ? `, { ${options.join(", ")} }` : "";
}

function isArrayInputType(ctx: EmitterCtx, type: Type): type is Model {
  return type.kind === "Model" && isArrayModelType(ctx.program, type);
}

interface BodyEmission {
  readonly decoderKinds: readonly BodyMediaKind[];
  readonly contentTypes: readonly string[];
  readonly optional: boolean;
}

/**
 * Resolves the body decode function and declared media types in one pass.
 * Multipart bodies default to `["multipart/form-data"]` when no list is set.
 */
function analyzeBody(op: HttpOperation): BodyEmission {
  const body = op.parameters.body;
  if (!body) return { decoderKinds: ["json"], contentTypes: [], optional: false };

  const declared =
    "contentTypes" in body && Array.isArray(body.contentTypes)
      ? body.contentTypes.filter((ct): ct is string => typeof ct === "string" && ct.length > 0)
      : [];

  if ("bodyKind" in body && body.bodyKind === "multipart") {
    return {
      decoderKinds: ["multipart"],
      contentTypes: declared.length > 0 ? declared : ["multipart/form-data"],
      optional: body.property?.optional === true,
    };
  }

  return {
    decoderKinds: declared.length > 0 ? getBodyMediaKinds(declared) : ["json"],
    contentTypes: declared,
    optional: body.property?.optional === true,
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
  const localNames = requestDecoderLocalNames(entries);
  if (entries.length === 1) {
    const [e] = entries;
    lines.push(
      `  ${tsObjectKey(name)}: ${e.expr}.map((${localNames[0]}) => ({ ${emitObjectAssignment(e.name, localNames[0])} })),`,
    );
  } else {
    const decoders = entries.map((e) => e.expr).join(", ");
    const args = localNames.join(", ");
    const resultProperties = entries
      .map((e, i) => emitObjectAssignment(e.name, localNames[i]))
      .join(", ");
    lines.push(`  ${tsObjectKey(name)}: RequestDecoders.combine(`);
    lines.push(`    [${decoders}],`);
    lines.push(`    (${args}) => ({ ${resultProperties} }),`);
    lines.push(`  ),`);
  }
  return { lines };
}

function requestDecoderLocalNames(
  entries: ReadonlyArray<{ name: string; expr: string }>,
): string[] {
  const used = new Set<string>();
  return entries.map((entry, index) => {
    const candidate = isTsIdentifier(entry.name) ? entry.name : `v${index}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }

    const fallback = `v${index}`;
    used.add(fallback);
    return fallback;
  });
}

function emitObjectAssignment(propertyName: string, localName: string): string {
  const key = tsObjectKey(propertyName);
  return key === localName ? localName : `${key}: ${localName}`;
}

function emitBodyDecoderEntry(
  name: string,
  ctx: EmitterCtx,
  dec: DecoderEmitContext,
  op: HttpOperation,
  emission: BodyEmission,
  options: { readonly wrapNonFlattenedBody?: boolean } = {},
): InputDecoderEntry {
  const lines: string[] = [];
  lines.push(`  ${tsObjectKey(name)}: {`);
  for (const kind of emission.decoderKinds) {
    const decoderExpr = emitBodyDecoderExpression(ctx, dec, op, kind);
    const expr =
      options.wrapNonFlattenedBody &&
      !isMultipartBody(op) &&
      !shouldFlattenBodyType(ctx, op.parameters.body!.type)
        ? `${decoderExpr}.map((body) => ({ body }))`
        : decoderExpr;
    lines.push(`    ${kind}: ${expr},`);
  }
  lines.push("  },");
  return { lines };
}

function emitBodyDecoderExpression(
  ctx: EmitterCtx,
  dec: DecoderEmitContext,
  op: HttpOperation,
  kind: BodyMediaKind,
): string {
  const body = op.parameters.body!;
  if (kind === "multipart" && isMultipartBody(op)) {
    return emitMultipartDecoderExpression(ctx, dec, body as any);
  }

  const mode: DecoderMode =
    kind === "form" || kind === "multipart" ? "form" : kind === "text" ? "text" : kind;
  return emitDecoderExpression(ctx, dec, body.type, mode);
}

function isMultipartBody(op: HttpOperation): boolean {
  const body = op.parameters.body;
  return body != null && "bodyKind" in body && body.bodyKind === "multipart" && "parts" in body;
}

function emitMultipartDecoderExpression(
  ctx: EmitterCtx,
  dec: DecoderEmitContext,
  body: {
    parts: ReadonlyArray<{
      name?: string;
      body: { bodyKind: string; type: Type };
      optional: boolean;
      multi: boolean;
    }>;
  },
): string {
  const fields: string[] = [];

  for (const part of body.parts) {
    if (!part.name) continue;
    const isFile = part.body.bodyKind === "file";
    let partDecoder = isFile
      ? "Decoders.file"
      : emitDecoderExpression(ctx, dec, part.body.type, "text");
    if (part.multi) {
      partDecoder = `Decoders.oneOrMany(${partDecoder})`;
    }
    if (part.optional) {
      partDecoder = `Decoders.optional(${partDecoder})`;
    }
    fields.push(`${tsObjectKey(part.name)}: ${partDecoder}`);
  }

  return `Decoders.object({ ${fields.join(", ")} })`;
}

// ---------------------------------------------------------------------------
// Inline decoder expression emission (single-line)
// ---------------------------------------------------------------------------

function buildBodyInputType(ctx: EmitterCtx, op: HttpOperation): string {
  const body = op.parameters.body;
  if (!body) return "Record<string, never>";
  if ("bodyKind" in body && body.bodyKind === "multipart" && "parts" in body) {
    return buildMultipartBodyType(ctx, body as any, body.property?.optional === true);
  }
  return shouldFlattenBodyType(ctx, body.type)
    ? typeToTs(ctx, body.type)
    : `{ body: ${typeToTs(ctx, body.type)} }`;
}

function buildBodyOnlyType(ctx: EmitterCtx, op: HttpOperation): string {
  const body = op.parameters.body;
  if (!body) return "Record<string, never>";
  if (isMultipartBody(op)) return buildMultipartBodyType(ctx, body as any, false);
  return typeToTs(ctx, body.type);
}

function buildMultipartBodyType(
  ctx: EmitterCtx,
  body: {
    parts: ReadonlyArray<{
      name?: string;
      body: { type: Type };
      optional: boolean;
      multi: boolean;
    }>;
  },
  allOptional: boolean,
): string {
  const parts: string[] = [];
  for (const part of body.parts) {
    if (!part.name) continue;
    let tsType = typeToTs(ctx, part.body.type);
    if (part.multi) tsType = `${tsType}[]`;
    parts.push(
      tsPropertyDeclaration(part.name, tsType, {
        optional: allOptional || part.optional,
      }),
    );
  }
  return parts.length > 0 ? `{ ${parts.join("; ")} }` : "Record<string, never>";
}

function buildRequestOnlyType(ctx: EmitterCtx, op: HttpOperation): string {
  const parts: string[] = [];
  for (const param of op.parameters.parameters) {
    parts.push(
      tsPropertyDeclaration(param.param.name, typeToTs(ctx, param.param.type), {
        optional: param.param.optional,
      }),
    );
  }
  if (parts.length === 0) return "Record<string, never>";
  return `{ ${parts.join("; ")} }`;
}

function emitDecoderExpression(
  ctx: EmitterCtx,
  dec: DecoderEmitContext,
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
        const arrayFn =
          mode === "json" || mode === "binary" ? "Decoders.strictArray" : "Decoders.array";
        expression = `${arrayFn}(${emitDecoderExpression(ctx, dec, type.indexer!.value, mode, seenModels)})`;
        break;
      }
      if (isRecordModelType(ctx.program, type)) {
        expression = `Decoders.record(${emitDecoderExpression(ctx, dec, type.indexer!.value, mode, seenModels)})`;
        break;
      }
      expression = emitObjectDecoder(ctx, dec, type, mode, seenModels);
      break;

    case "Union":
      expression = emitUnionDecoder(ctx, dec, type, mode, seenModels);
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
        .map((value) => emitDecoderExpression(ctx, dec, value, mode, seenModels))
        .join(", ")}])`;
      break;

    case "UnionVariant":
      expression = emitDecoderExpression(ctx, dec, type.type, mode, seenModels);
      break;

    case "ModelProperty":
      return emitDecoderExpression(ctx, dec, type.type, mode, seenModels, type);

    default:
      expression = "Decoders.unknown";
      break;
  }

  return applyValidationDecorators(ctx, expression, type, target);
}

function emitScalarDecoder(scalar: Scalar, mode: DecoderMode): string {
  const strict = mode === "json" || mode === "binary";
  const integer = strict ? "Decoders.strictInteger" : "Decoders.integer";
  const number = strict ? "Decoders.strictNumber" : "Decoders.number";
  const bigint = strict ? "Decoders.strictBigint" : "Decoders.bigint";

  switch (intrinsicScalarName(scalar)) {
    case "int8":
      return withNumericRange(integer, "-128", "127");
    case "uint8":
      return withNumericRange(integer, "0", "255");
    case "int16":
      return withNumericRange(integer, "-32768", "32767");
    case "uint16":
      return withNumericRange(integer, "0", "65535");
    case "int32":
      return withNumericRange(integer, "-2147483648", "2147483647");
    case "uint32":
      return withNumericRange(integer, "0", "4294967295");
    case "int64": {
      return withNumericRange(bigint, "-9223372036854775808n", "9223372036854775807n");
    }
    case "uint64":
      return withNumericRange(bigint, "0n", "18446744073709551615n");
    case "integer":
      return integer;
    case "safeint":
      return strict ? "Decoders.strictSafeInteger" : "Decoders.safeInteger";
    case "float32":
    case "float64":
    case "float":
    case "numeric":
    case "decimal":
    case "decimal128":
      return number;
    case "string":
    case "url":
    case "plainDate":
    case "plainTime":
    case "utcDateTime":
    case "offsetDateTime":
    case "duration":
      return "Decoders.string";
    case "boolean":
      return strict ? "Decoders.strictBoolean" : "Decoders.boolean";
    case "bytes":
      return mode === "json" ? "Decoders.strictBytes" : "Decoders.bytes";
    default:
      return mode === "text" ? "Decoders.string" : "Decoders.unknown";
  }
}

function intrinsicScalarName(scalar: Scalar): string {
  let current: Scalar | undefined = scalar;
  while (current) {
    if (current.namespace?.name === "TypeSpec") return current.name;
    current = current.baseScalar;
  }
  return scalar.name;
}

function withNumericRange(decoder: string, min: string, max: string): string {
  return `${decoder}.validate(Validators.minValue(${min}), Validators.maxValue(${max}))`;
}

function emitObjectDecoder(
  ctx: EmitterCtx,
  dec: DecoderEmitContext,
  model: Model,
  mode: DecoderMode,
  seenModels: ReadonlySet<string>,
): string {
  if (mode === "text") return "Decoders.unknown";

  const modelName = model.name ? getGeneratedTypeName(ctx, model, "Model") : undefined;

  if (modelName && seenModels.has(modelName)) {
    const key = `${mode}:${modelName}`;
    if (!dec.lazyDecoders.has(key)) {
      const modeSuffix = mode === "json" ? "" : `${mode[0]!.toUpperCase()}${mode.slice(1)}`;
      dec.lazyDecoders.set(key, {
        model,
        modelName,
        mode,
        varName: `_lazy${dec.scopeName.length}_${dec.scopeName}_${modelName.length}_${modelName}_${modeSuffix || "json"}`,
      });
    }
    return dec.lazyDecoders.get(key)!.varName;
  }

  const nextSeen = modelName ? new Set([...seenModels, modelName]) : seenModels;

  const fields = modelDecoderProperties(model)
    .map((prop) => {
      const propertyDecoder = emitDecoderExpression(ctx, dec, prop.type, mode, nextSeen, prop);
      const expr = prop.optional ? `Decoders.optional(${propertyDecoder})` : propertyDecoder;
      return `${tsObjectKey(prop.name)}: ${expr}`;
    })
    .join(", ");

  return `Decoders.object<${typeToTs(ctx, model)}>({ ${fields} })`;
}

function emitUnionDecoder(
  ctx: EmitterCtx,
  dec: DecoderEmitContext,
  union: Union,
  mode: DecoderMode,
  seenModels: ReadonlySet<string>,
): string {
  if (mode === "json") {
    const discriminated = emitDiscriminatedUnionDecoder(ctx, dec, union, seenModels);
    if (discriminated) return discriminated;
  }
  const variants = [...union.variants.values()]
    .map((variant) => emitDecoderExpression(ctx, dec, variant.type, mode, seenModels))
    .join(", ");
  return `Decoders.union<${typeToTs(ctx, union)}>([${variants}])`;
}

/**
 * Emits `Decoders.discriminated(...)` for tagged unions — O(1) dispatch on the
 * tag field instead of the linear scan `Decoders.union(...)` does. Applies when
 * every variant is a plain model carrying the same required literal-typed
 * property with a distinct value. The field comes from `@discriminator` when
 * present (only older compilers allow it on unions; kept for symmetry with
 * response dispatch) and is otherwise inferred as a common literal field
 * across the variants. Returns undefined when no such field exists so the
 * caller falls back.
 */
function emitDiscriminatedUnionDecoder(
  ctx: EmitterCtx,
  dec: DecoderEmitContext,
  union: Union,
  seenModels: ReadonlySet<string>,
): string | undefined {
  const models = discriminatableModels(ctx, union);
  if (!models) return undefined;

  const field =
    getDiscriminator(ctx.program, union)?.propertyName ?? inferCommonLiteralField(models);
  if (!field) return undefined;

  const entries: string[] = [];
  const tags = new Set<string>();
  for (const model of models) {
    const tag = literalTagValue(model, field);
    if (tag === undefined || tags.has(tag)) return undefined;
    tags.add(tag);
    entries.push(
      `${JSON.stringify(tag)}: ${emitDecoderExpression(ctx, dec, model, "json", seenModels)}`,
    );
  }

  return `Decoders.discriminated<${typeToTs(ctx, union)}>(${JSON.stringify(field)}, { ${entries.join(", ")} })`;
}

/** All variants as plain (non-array, non-record) models, or undefined. */
function discriminatableModels(ctx: EmitterCtx, union: Union): Model[] | undefined {
  const types = [...union.variants.values()].map((variant) => variant.type);
  if (types.length < 2) return undefined;
  const models = types.filter(
    (type): type is Model =>
      type.kind === "Model" &&
      !isArrayModelType(ctx.program, type) &&
      !isRecordModelType(ctx.program, type),
  );
  return models.length === types.length ? models : undefined;
}

/**
 * First property of the first variant that is a required literal in every
 * variant with values distinct across them.
 */
function inferCommonLiteralField(models: readonly Model[]): string | undefined {
  const [first, ...rest] = models;
  for (const prop of walkPropertiesInherited(first!)) {
    const value = literalTagValue(first!, prop.name);
    if (value === undefined) continue;
    const values = new Set([value]);
    const viable = rest.every((model) => {
      const tag = literalTagValue(model, prop.name);
      if (tag === undefined || values.has(tag)) return false;
      values.add(tag);
      return true;
    });
    if (viable) return prop.name;
  }
  return undefined;
}

/** The model's required literal value for `field`, stringified for tag lookup. */
function literalTagValue(model: Model, field: string): string | undefined {
  for (const prop of walkPropertiesInherited(model)) {
    if (prop.name !== field) continue;
    if (prop.optional) return undefined;
    if (prop.type.kind !== "String" && prop.type.kind !== "Number") return undefined;
    return String(prop.type.value);
  }
  return undefined;
}

/**
 * Builds hoisted `Decoders.lazy(() => ...)` declarations for any recursive models
 * that were detected during decoder emission.
 */
export function buildHoistedDecoders(ctx: EmitterCtx, dec: DecoderEmitContext): string[] {
  // We need to emit each lazy decoder with a full object decoder inside.
  // The model was seen during emission but its decoder was deferred — emit it now.
  for (const [key, lazy] of dec.lazyDecoders) {
    if (dec.emittedLazy.has(key)) continue;
    dec.emittedLazy.add(key);

    const fields = modelDecoderProperties(lazy.model)
      .map((prop) => {
        const propertyDecoder = emitDecoderExpression(
          ctx,
          dec,
          prop.type,
          lazy.mode,
          new Set([lazy.modelName]),
          prop,
        );
        const expr = prop.optional ? `Decoders.optional(${propertyDecoder})` : propertyDecoder;
        return `${tsObjectKey(prop.name)}: ${expr}`;
      })
      .join(", ");

    const tsType = typeToTs(ctx, lazy.model);
    dec.hoistedDecoderLines.push(
      `const ${lazy.varName}: Decoder<${tsType}> = Decoders.lazy(() => Decoders.object<${tsType}>({ ${fields} }));`,
    );
  }
  return [...dec.hoistedDecoderLines];
}

function modelDecoderProperties(model: Model): ModelProperty[] {
  return [...walkPropertiesInherited(model)];
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

function emitValidatorsForTarget(ctx: EmitterCtx, target: Type, kind: DecodedTypeKind): string[] {
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
      `Validators.pattern(${JSON.stringify(pattern.pattern)}${pattern.validationMessage ? `, ${JSON.stringify(pattern.validationMessage)}` : ""})`,
    );
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
