import type {
  HttpOperation,
  HttpOperationMultipartBody,
  HttpOperationParameter,
  HttpOperationPart,
} from "@typespec/http";
import { isHeader } from "@typespec/http";
import type {
  DiscriminatedUnion,
  Enum,
  Model,
  ModelProperty,
  Scalar,
  Type,
  Union,
} from "@typespec/compiler";
import { getDiscriminator, isArrayModelType, walkPropertiesInherited } from "@typespec/compiler";
import { getBodyMediaKinds, type BodyMediaKind } from "./body-media-kinds.js";
import { getGeneratedTypeName, type EmitterCtx } from "./ctx.js";
import { emitDateTimeDecoder } from "./datetime-mode.js";
import {
  discriminatedVariantToTs,
  discriminatedVariants,
  resolveDiscriminatedUnion,
} from "./discriminated-unions.js";
import { buildInputType } from "./emit-server-common.js";
import { propertiesShareSource } from "./http-models.js";
import { getExplodedQueryModelProperties, isExplodedQueryRecord } from "./http-parameter-shapes.js";
import { getJsonPropertyWireName } from "./json-wire-transforms.js";
import {
  getAdditionalPropertiesValue,
  isNeverAdditionalProperties,
  isPureRecordModel,
} from "./model-indexer.js";
import { multipartBodyTypeToTs } from "./multipart-input.js";
import { getSameEndpointOverloads } from "./operation-surface.js";
import {
  getPayloadCollection,
  getRequestBodyProjection,
  payloadItemProjection,
  payloadModelProperties,
  payloadProjectionChangesType,
  payloadPropertyOptional,
  payloadTypeToTs,
  type PayloadProjection,
} from "./payload-context.js";
import { getIntrinsicScalarName } from "./scalar-map.js";
import { emitScalarEncodingDecoder, resolveScalarEncoding } from "./scalar-encoding.js";
import {
  getRequestInputPlan,
  shouldFlattenBodyType,
  type RequestBodyInputPlan,
} from "./request-input-plan.js";
import { typeToTs } from "./type-reference.js";
import {
  isTsIdentifier,
  tsIdentifier,
  tsLiteral,
  tsObjectKey,
  tsPropertyAccess,
  tsPropertyDeclaration,
} from "./typescript-names.js";
import { decodedTypeKind, emitValidatorsForTarget } from "./validation-emission.js";
import {
  enumMemberLiteralExpression,
  numericLiteralExpression,
  resolveNumericLiteral,
} from "./numeric-literals.js";
import {
  getStringLiteralValue,
  isStringLikeLiteral,
  stringLiteralExpression,
} from "./string-template-literals.js";

type DecoderMode = "json" | "text" | "form" | "binary";

/** Tracks hoisted lazy decoders for recursive named types during a single emitDecoder call. */
interface DecoderEmitContext {
  readonly scopeName: string;
  /** Semantic TypeSpec identity → mode/projection → hoisted lazy decoder. */
  readonly lazyDecoders: Map<Type, Map<string, LazyDecoderEmission>>;
  /** Tracks which lazy decoders have been fully emitted (not just referenced). */
  readonly emittedLazy: Set<LazyDecoderEmission>;
  /** Cumulative declarations returned by every hoisting pass. */
  readonly hoistedDecoderLines: string[];
}

interface LazyDecoderEmission {
  readonly type: Model | Union;
  readonly mode: DecoderMode;
  readonly projection?: PayloadProjection;
  readonly varName: string;
}

function createDecoderEmitContext(inputsRef: string, operationName: string): DecoderEmitContext {
  const identifier = tsIdentifier(`${inputsRef}_${operationName}`, "Operation");
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
  const dec = createDecoderEmitContext(inputsRef, opName);
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
    const collection =
      param.param.type.kind === "Model" ? getPayloadCollection(ctx, param.param.type) : undefined;
    if (collection?.kind === "record") {
      optionValues.push("record: true");
      if (param.style === "label" || param.style === "matrix") {
        optionValues.push("emptyComposite: true");
      }
      if (param.explode) {
        optionValues.push("explode: true");
        if (param.style === "path") optionValues.push('recordSeparator: "/"');
        else if (param.style === "label") optionValues.push('recordSeparator: "."');
        else if (param.style === "matrix") optionValues.push('recordSeparator: ";"');
      }
    } else if (isArrayInputType(ctx, param.param.type)) {
      optionValues.push("array: true");
      if (param.style === "path" && param.explode) {
        optionValues.push('arraySeparator: "/"');
      } else if (param.style === "label" && param.explode) {
        optionValues.push('arraySeparator: "."');
      } else if (param.style === "matrix" && param.explode) {
        optionValues.push(`arraySeparator: ${tsLiteral(`;${param.name}=`)}`);
      }
    }
    const options = optionValues.length > 0 ? `, { ${optionValues.join(", ")} }` : "";
    requestEntries.push({
      name: param.param.name,
      expr: `RequestDecoders.path(${tsLiteral(param.name)}, ${decoder}${options})`,
    });
  }
  for (const param of queryParams) {
    const explodedModelProperties = getExplodedQueryModelProperties(ctx, param);
    const valueDecoder = emitDecoderExpression(
      ctx,
      dec,
      param.param.type,
      explodedModelProperties ? "form" : "text",
      new Set(),
      param.param,
    );
    const decoder = param.param.optional ? `${valueDecoder}.optional()` : valueDecoder;
    const collection =
      param.param.type.kind === "Model" ? getPayloadCollection(ctx, param.param.type) : undefined;
    let options = "";
    if (collection?.kind === "record") {
      const optionValues = ["record: true"];
      if (param.explode) {
        optionValues.push("explode: true");
        const excludedNames = [
          ...new Set(
            queryParams
              .filter((candidate) => candidate !== param)
              .flatMap((candidate) => queryParameterClaimedNames(ctx, candidate)),
          ),
        ].map(tsLiteral);
        if (excludedNames.length > 0) {
          optionValues.push(`excludedNames: [${excludedNames.join(", ")}]`);
        }
      } else {
        optionValues.push("emptyComposite: true", "explode: false");
      }
      options = `, { ${optionValues.join(", ")} }`;
    } else if (explodedModelProperties) {
      const optionValues = ["record: true", "explode: true"];
      if (!param.param.optional) optionValues.push("emptyComposite: true");
      const includedNames = explodedModelProperties.map((property) => tsLiteral(property.name));
      optionValues.push(`includedNames: [${includedNames.join(", ")}]`);
      options = `, { ${optionValues.join(", ")} }`;
    } else if (isArrayInputType(ctx, param.param.type)) {
      options = `, { array: true, explode: ${param.explode} }`;
    }
    requestEntries.push({
      name: param.param.name,
      expr: `RequestDecoders.query(${tsLiteral(param.name)}, ${decoder}${options})`,
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
      expr: `RequestDecoders.header(${tsLiteral(param.name.toLowerCase())}, ${decoder}${options})`,
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
      expr: `RequestDecoders.cookie(${tsLiteral(param.name)}, ${decoder}${options})`,
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

  const body = hasBody ? analyzeBody(ctx, op) : undefined;
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
  const bodyPlan = getRequestInputPlan(ctx, op).body;
  return {
    inputEntries: [
      emitRequestDecoderEntry(`${opName}Request`, requestEntries),
      emitBodyDecoderEntry(`${opName}Body`, ctx, dec, op, body!, bodyPlan),
    ],
    decodeExpression: `decodeRequestInputAndBody<${requestType}, ${bodyInputType}>(${requestRef}, ${bodyRef}, request, pathParams${bodyOptionsArg})`,
    needsPathParams: true,
    isAsync: true,
    hoistedDecoders: buildHoistedDecoders(ctx, dec),
  };
}

function queryParameterClaimedNames(
  ctx: EmitterCtx,
  parameter: HttpOperationParameter,
): readonly string[] {
  const explodedModelProperties = getExplodedQueryModelProperties(ctx, parameter);
  if (explodedModelProperties) {
    return explodedModelProperties.map((property) => property.name);
  }
  return isExplodedQueryRecord(ctx, parameter) ? [] : [parameter.name];
}

/** Emits the trailing body decode options argument, or an empty string. */
function emitBodyOptionsArg(emission: BodyEmission): string {
  const options: string[] = [];
  if (emission.contentTypes.length > 0) {
    const literal = emission.contentTypes.map((ct) => tsLiteral(ct)).join(", ");
    options.push(`contentTypes: [${literal}]`);
  }
  if (emission.allowMissingContentType) options.push("allowMissingContentType: true");
  if (emission.fileNameProperty && emission.fileBodyProperty) {
    options.push(`fileNameProperty: ${tsLiteral(emission.fileNameProperty)}`);
    options.push(`fileBodyProperty: ${tsLiteral(emission.fileBodyProperty)}`);
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
  readonly allowMissingContentType?: boolean;
  readonly fileNameProperty?: string;
  readonly fileBodyProperty?: string;
  readonly optional: boolean;
}

/**
 * Resolves the body decode function and declared media types in one pass.
 * Multipart bodies default to `["multipart/form-data"]` when no list is set.
 */
function analyzeBody(ctx: EmitterCtx, op: HttpOperation): BodyEmission {
  const body = op.parameters.body;
  if (!body) return { decoderKinds: ["json"], contentTypes: [], optional: false };

  const declared =
    "contentTypes" in body && Array.isArray(body.contentTypes)
      ? body.contentTypes.filter((ct): ct is string => typeof ct === "string" && ct.length > 0)
      : [];

  if ("bodyKind" in body && body.bodyKind === "file") {
    const filenameParameter = op.parameters.parameters.find((parameter) =>
      propertiesShareSource(parameter.param, body.filename),
    );
    const bodyPlan = getRequestInputPlan(ctx, op).body;
    const fileBodyProperty = bodyPlan?.placement === "wrapped" ? bodyPlan.propertyName : undefined;
    return {
      decoderKinds: ["file"],
      contentTypes: declared,
      allowMissingContentType: body.contentTypeProperty.optional,
      fileNameProperty: filenameParameter?.param.name,
      fileBodyProperty: filenameParameter ? fileBodyProperty : undefined,
      optional: body.property?.optional === true,
    };
  }

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
    const base = isTsIdentifier(entry.name) ? entry.name : `v${index}`;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    return candidate;
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
  plan?: RequestBodyInputPlan,
): InputDecoderEntry {
  const lines: string[] = [];
  const overloadsByKind = indexOverloadBodiesByMediaKind(ctx, op);
  lines.push(`  ${tsObjectKey(name)}: {`);
  for (const kind of emission.decoderKinds) {
    const decoderExpr = emitOverloadAwareBodyDecoderExpression(
      ctx,
      dec,
      op,
      kind,
      overloadsByKind.get(kind) ?? [],
    );
    const expr =
      plan?.placement === "wrapped"
        ? `${decoderExpr}.map((body) => ({ ${emitObjectAssignment(plan.propertyName, "body")} }))`
        : decoderExpr;
    lines.push(`    ${kind}: ${expr},`);
  }
  lines.push("  },");
  return { lines };
}

function indexOverloadBodiesByMediaKind(
  ctx: EmitterCtx,
  op: HttpOperation,
): ReadonlyMap<BodyMediaKind, readonly HttpOperation[]> {
  const indexed = new Map<BodyMediaKind, HttpOperation[]>();
  for (const overload of getSameEndpointOverloads(op)) {
    if (!overload.parameters.body) continue;
    for (const kind of analyzeBody(ctx, overload).decoderKinds) {
      const operations = indexed.get(kind) ?? [];
      operations.push(overload);
      indexed.set(kind, operations);
    }
  }
  return indexed;
}

function emitOverloadAwareBodyDecoderExpression(
  ctx: EmitterCtx,
  dec: DecoderEmitContext,
  op: HttpOperation,
  kind: BodyMediaKind,
  overloads: readonly HttpOperation[],
): string {
  if (overloads.length === 0) return emitBodyDecoderExpression(ctx, dec, op, kind);

  const expressions = [
    ...new Set(overloads.map((overload) => emitBodyDecoderExpression(ctx, dec, overload, kind))),
  ];
  if (expressions.length === 1) return expressions[0]!;

  return `Decoders.union<${buildBodyOnlyType(ctx, op)}>([${expressions.join(", ")}])`;
}

function emitBodyDecoderExpression(
  ctx: EmitterCtx,
  dec: DecoderEmitContext,
  op: HttpOperation,
  kind: BodyMediaKind,
): string {
  const body = op.parameters.body!;
  if (kind === "file" && body.bodyKind === "file") {
    return "Decoders.file";
  }
  if (kind === "multipart" && body.bodyKind === "multipart") {
    return emitMultipartDecoderExpression(ctx, dec, body);
  }

  const mode: DecoderMode =
    kind === "form" || kind === "multipart"
      ? "form"
      : kind === "text"
        ? "text"
        : kind === "file"
          ? "binary"
          : kind;
  return emitDecoderExpression(
    ctx,
    dec,
    body.type,
    mode,
    new Set(),
    body.property,
    getEffectiveRequestBodyProjection(ctx, op),
  );
}

function emitMultipartDecoderExpression(
  ctx: EmitterCtx,
  dec: DecoderEmitContext,
  body: HttpOperationMultipartBody,
): string {
  const bodyType = multipartBodyTypeToTs(ctx, body);
  const combinator =
    body.multipartKind === "tuple" ? "Decoders.multipartTuple" : "Decoders.multipartFormData";
  const descriptors = body.parts.map((part) =>
    emitMultipartPartDescriptor(ctx, dec, part, body.multipartKind),
  );
  return `${combinator}<${bodyType}>([${descriptors.join(", ")}])`;
}

type MultipartPartKind = "text" | "binary" | "json" | "file";

function emitMultipartPartDescriptor(
  ctx: EmitterCtx,
  dec: DecoderEmitContext,
  part: HttpOperationPart,
  multipartKind: HttpOperationMultipartBody["multipartKind"],
): string {
  const kinds = multipartPartKinds(part);
  const fields: string[] = [];
  if (kinds.length === 1) {
    const [kind] = kinds;
    fields.push(`decoder: ${emitMultipartPartDecoder(ctx, dec, part, kind)}`);
    fields.push(`kind: ${tsLiteral(kind)}`);
  } else {
    const decoders = kinds.map(
      (kind) => `${kind}: ${emitMultipartPartDecoder(ctx, dec, part, kind)}`,
    );
    fields.push(`decoders: { ${decoders.join(", ")} }`);
  }

  if (part.body.contentTypes.length > 0) {
    fields.push(`contentTypes: ${tsLiteral(part.body.contentTypes)}`);
  }
  if (part.body.contentTypeProperty?.optional === false) {
    fields.push("requireContentType: true");
  }
  if (part.optional) fields.push("optional: true");
  if (part.multi) fields.push("multi: true");

  if (part.name !== undefined) {
    fields.push(`name: ${tsLiteral(part.name)}`);
  }
  if (multipartKind === "model" && part.partKind === "model") {
    fields.push(`property: ${tsLiteral(part.property.name)}`);
  }

  if (part.body.bodyKind === "file") {
    const fileName = part.filename;
    const fileNameHeader = fileName
      ? part.headers.find((header) => propertiesShareSource(header.property, fileName))
      : undefined;
    if (fileNameHeader) {
      fields.push(`fileNameHeader: ${tsLiteral(fileNameHeader.options.name)}`);
    }
    if (fileName?.optional === false) {
      fields.push("requireFileName: true");
    }
  }

  return `{ ${fields.join(", ")} }`;
}

function emitMultipartPartDecoder(
  ctx: EmitterCtx,
  dec: DecoderEmitContext,
  part: HttpOperationPart,
  kind: MultipartPartKind,
): string {
  return kind === "file"
    ? "Decoders.file"
    : emitDecoderExpression(ctx, dec, part.body.type, kind, new Set(), part.body.property);
}

function multipartPartKinds(part: HttpOperationPart): readonly MultipartPartKind[] {
  if (part.body.bodyKind === "file") return ["file"];

  const kinds = getBodyMediaKinds(part.body.contentTypes);
  const supported: MultipartPartKind[] = [];
  for (const kind of kinds) {
    if ((kind === "json" || kind === "text" || kind === "binary") && !supported.includes(kind)) {
      supported.push(kind);
    }
  }
  if (supported.length > 0) return supported;
  // TypeSpec normally resolves a default media type for every part. An absent
  // list is the sole safe text default; unsupported resolved kinds are
  // diagnosed during request preflight and intentionally stay empty here.
  return part.body.contentTypes.length === 0 ? ["text"] : [];
}

// ---------------------------------------------------------------------------
// Inline decoder expression emission (single-line)
// ---------------------------------------------------------------------------

function buildBodyInputType(ctx: EmitterCtx, op: HttpOperation): string {
  const body = op.parameters.body;
  if (!body) return "Record<string, never>";
  const plan = getRequestInputPlan(ctx, op).body;
  if ("bodyKind" in body && body.bodyKind === "multipart" && "parts" in body) {
    const bodyType = multipartBodyTypeToTs(
      ctx,
      body,
      plan?.placement === "wrapped" ? false : body.property?.optional === true,
    );
    return plan?.placement === "wrapped"
      ? `{ ${tsPropertyDeclaration(plan.propertyName!, bodyType)} }`
      : bodyType;
  }
  const projection = getEffectiveRequestBodyProjection(ctx, op);
  const bodyType = payloadTypeToTs(ctx, body.type, projection);
  return plan?.placement === "wrapped"
    ? `{ ${tsPropertyDeclaration(plan.propertyName, bodyType)} }`
    : bodyType;
}

function buildBodyOnlyType(ctx: EmitterCtx, op: HttpOperation): string {
  const body = op.parameters.body;
  if (!body) return "Record<string, never>";
  if ("bodyKind" in body && body.bodyKind === "multipart" && "parts" in body) {
    return multipartBodyTypeToTs(ctx, body);
  }
  return payloadTypeToTs(ctx, body.type, getEffectiveRequestBodyProjection(ctx, op));
}

function getEffectiveRequestBodyProjection(
  ctx: EmitterCtx,
  op: HttpOperation,
): PayloadProjection | undefined {
  const body = op.parameters.body;
  if (!body) return undefined;
  const projection = getRequestBodyProjection(ctx, op);
  return payloadProjectionChangesType(ctx, body.type, projection) ? projection : undefined;
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
  seenTypes: ReadonlySet<Type> = new Set(),
  target?: ModelProperty,
  projection?: PayloadProjection,
  encodingTarget: ModelProperty | undefined = target,
): string {
  let expression: string;
  switch (type.kind) {
    case "Scalar":
      expression = emitScalarDecoder(ctx, type, mode, encodingTarget);
      break;

    case "Model":
      const collection = getPayloadCollection(ctx, type);
      if (collection?.kind === "array") {
        const arrayFn =
          mode === "json" || mode === "binary" ? "Decoders.strictArray" : "Decoders.array";
        expression = `${arrayFn}(${emitDecoderExpression(
          ctx,
          dec,
          collection.value,
          mode,
          seenTypes,
          undefined,
          payloadItemProjection(projection),
          encodingTarget,
        )})`;
        break;
      }
      if (collection?.kind === "record") {
        expression = `Decoders.record(${emitDecoderExpression(
          ctx,
          dec,
          collection.value,
          mode,
          seenTypes,
          undefined,
          payloadItemProjection(projection),
          encodingTarget,
        )})`;
        break;
      }
      expression = emitObjectDecoder(ctx, dec, type, mode, seenTypes, projection);
      break;

    case "Union":
      expression = emitUnionDecoder(ctx, dec, type, mode, seenTypes, projection, encodingTarget);
      break;

    case "Enum":
      expression = emitEnumDecoder(ctx, type, mode);
      break;

    case "String":
    case "StringTemplate": {
      const lit = mode === "json" ? "Decoders.strictLiteral" : "Decoders.literal";
      expression = `${lit}(${stringLiteralExpression(type)})`;
      break;
    }

    case "Number": {
      const lit = mode === "json" ? "Decoders.strictLiteral" : "Decoders.literal";
      expression = `${lit}(${numericLiteralExpression(type)})`;
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
        case "never":
          expression = "Decoders.never";
          break;
        case "unknown":
          expression = "Decoders.unknown";
          break;
        default:
          expression = "Decoders.unknown";
          break;
      }
      break;

    case "Tuple":
      expression = `Decoders.tuple<${payloadTypeToTs(ctx, type, projection)}>([${type.values
        .map((value) =>
          emitDecoderExpression(
            ctx,
            dec,
            value,
            mode,
            seenTypes,
            undefined,
            payloadItemProjection(projection),
            encodingTarget,
          ),
        )
        .join(", ")}])`;
      break;

    case "UnionVariant":
      expression = emitDecoderExpression(
        ctx,
        dec,
        type.type,
        mode,
        seenTypes,
        undefined,
        projection,
        encodingTarget,
      );
      break;

    case "ModelProperty":
      return emitDecoderExpression(ctx, dec, type.type, mode, seenTypes, type, projection, type);

    default:
      expression = "Decoders.unknown";
      break;
  }

  return applyValidationDecorators(ctx, expression, type, target);
}

function emitScalarDecoder(
  ctx: EmitterCtx,
  scalar: Scalar,
  mode: DecoderMode,
  target?: ModelProperty,
): string {
  const context =
    mode === "binary" ? "binary" : target && isHeader(ctx.program, target) ? "header" : "value";
  const encoding = resolveScalarEncoding(ctx, scalar, target, context);
  if (encoding.status === "supported") {
    const wireDecoder = applyValidationDecorators(
      ctx,
      emitUnencodedScalarDecoder(encoding.plan.wireType, mode),
      encoding.plan.wireType,
    );
    return emitScalarEncodingDecoder(ctx, encoding.plan, wireDecoder);
  }
  return emitDateTimeDecoder(ctx, scalar, emitUnencodedScalarDecoder(scalar, mode));
}

function emitUnencodedScalarDecoder(scalar: Scalar, mode: DecoderMode): string {
  const strict = mode === "json" || mode === "binary";
  const integer = strict ? "Decoders.strictInteger" : "Decoders.integer";
  const number = strict ? "Decoders.strictNumber" : "Decoders.number";
  const bigint = strict ? "Decoders.strictBigint" : "Decoders.bigint";

  switch (getIntrinsicScalarName(scalar)) {
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

function withNumericRange(decoder: string, min: string, max: string): string {
  return `${decoder}.validate(Validators.minValue(${min}), Validators.maxValue(${max}))`;
}

function emitObjectDecoder(
  ctx: EmitterCtx,
  dec: DecoderEmitContext,
  model: Model,
  mode: DecoderMode,
  seenTypes: ReadonlySet<Type>,
  projection?: PayloadProjection,
): string {
  if (mode === "text") return "Decoders.unknown";

  const typeName = model.name ? getGeneratedTypeName(ctx, model, "Model") : undefined;

  if (typeName && seenTypes.has(model)) {
    return getOrCreateLazyDecoder(dec, model, typeName, mode, projection).varName;
  }

  const nextSeen = typeName ? new Set([...seenTypes, model]) : seenTypes;
  return emitObjectDecoderBody(ctx, dec, model, mode, nextSeen, projection);
}

function emitObjectDecoderBody(
  ctx: EmitterCtx,
  dec: DecoderEmitContext,
  model: Model,
  mode: DecoderMode,
  seenTypes: ReadonlySet<Type>,
  projection?: PayloadProjection,
  syntheticDiscriminator?: {
    readonly name: string;
    readonly tag?: string;
    readonly typeTs: string;
  },
): string {
  const properties = payloadModelProperties(model, projection);
  const fields: string[] = [];
  if (
    syntheticDiscriminator &&
    !properties.some((property) => property.name === syntheticDiscriminator.name)
  ) {
    fields.push(
      `${tsObjectKey(syntheticDiscriminator.name)}: ${emitSyntheticDiscriminatorDecoder(syntheticDiscriminator.tag)}`,
    );
  }
  for (const prop of properties) {
    const isSyntheticDiscriminator = prop.name === syntheticDiscriminator?.name;
    const propertyDecoder =
      isSyntheticDiscriminator && syntheticDiscriminator.tag !== undefined
        ? emitSyntheticDiscriminatorDecoder(syntheticDiscriminator.tag)
        : emitDecoderExpression(ctx, dec, prop.type, mode, seenTypes, prop, projection);
    const expr =
      !isSyntheticDiscriminator && payloadPropertyOptional(prop, projection)
        ? `Decoders.optional(${propertyDecoder})`
        : propertyDecoder;
    fields.push(`${tsObjectKey(prop.name)}: ${expr}`);
  }

  const options: string[] = [];
  if (mode === "json") {
    const wireNames = properties
      .map(
        (property) =>
          [
            property.name,
            property.name === syntheticDiscriminator?.name
              ? syntheticDiscriminator.name
              : getJsonPropertyWireName(ctx, property),
          ] as const,
      )
      .filter(([propertyName, wireName]) => propertyName !== wireName);
    if (wireNames.length > 0) {
      options.push(
        `wireNames: { ${wireNames
          .map(([propertyName, wireName]) => `${tsObjectKey(propertyName)}: ${tsLiteral(wireName)}`)
          .join(", ")} }`,
      );
    }
  }
  const additionalProperties = getAdditionalPropertiesValue(model);
  if (additionalProperties === undefined) {
    // TypeSpec/OpenAPI object schemas are open unless explicitly sealed. The
    // typed handler contract still contains only declared properties, so
    // unmodeled values are accepted and intentionally omitted.
    options.push("allowUnknown: true");
  } else if (!isNeverAdditionalProperties(model)) {
    options.push(
      `additionalProperties: ${emitDecoderExpression(
        ctx,
        dec,
        additionalProperties,
        mode,
        seenTypes,
        undefined,
        payloadItemProjection(projection),
      )}`,
    );
  }

  if (projection) {
    const included = new Set(properties.map((property) => property.name));
    const forbidden = [...walkPropertiesInherited(model)]
      .filter(
        (property) =>
          !included.has(property.name) && property.name !== syntheticDiscriminator?.name,
      )
      .map((property) =>
        mode === "json" ? getJsonPropertyWireName(ctx, property) : property.name,
      );
    if (forbidden.length > 0) {
      options.push(`forbiddenProperties: ${tsLiteral(forbidden)}`);
    }
  }

  const optionsArg = options.length > 0 ? `, { ${options.join(", ")} }` : "";
  const typeTs = syntheticDiscriminator?.typeTs ?? payloadTypeToTs(ctx, model, projection);
  return `Decoders.object<${typeTs}>({ ${fields.join(", ")} }${optionsArg})`;
}

function emitSyntheticDiscriminatorDecoder(tag: string | undefined): string {
  return tag === undefined ? "Decoders.string" : `Decoders.strictLiteral(${tsLiteral(tag)})`;
}

function emitUnionDecoder(
  ctx: EmitterCtx,
  dec: DecoderEmitContext,
  union: Union,
  mode: DecoderMode,
  seenTypes: ReadonlySet<Type>,
  projection?: PayloadProjection,
  encodingTarget?: ModelProperty,
): string {
  const typeName = union.name ? getGeneratedTypeName(ctx, union, "Union") : undefined;
  if (typeName && seenTypes.has(union)) {
    return getOrCreateLazyDecoder(dec, union, typeName, mode, projection).varName;
  }

  const nextSeen = typeName ? new Set([...seenTypes, union]) : seenTypes;
  return emitUnionDecoderBody(ctx, dec, union, mode, nextSeen, projection, encodingTarget);
}

function emitUnionDecoderBody(
  ctx: EmitterCtx,
  dec: DecoderEmitContext,
  union: Union,
  mode: DecoderMode,
  seenTypes: ReadonlySet<Type>,
  projection?: PayloadProjection,
  encodingTarget?: ModelProperty,
): string {
  if (mode === "json") {
    const declared = resolveDiscriminatedUnion(ctx.program, union);
    if (declared) {
      return emitDeclaredDiscriminatedUnionDecoder(
        ctx,
        dec,
        declared,
        seenTypes,
        projection,
        encodingTarget,
      );
    }
    if (!payloadProjectionChangesType(ctx, union, projection)) {
      const inferred = emitStructuralDiscriminatedUnionDecoder(ctx, dec, union, seenTypes);
      if (inferred) return inferred;
    }
  }
  const variants = [...union.variants.values()]
    .map((variant) =>
      emitDecoderExpression(
        ctx,
        dec,
        variant.type,
        mode,
        seenTypes,
        undefined,
        projection,
        encodingTarget,
      ),
    )
    .join(", ");
  return `Decoders.union<${payloadTypeToTs(ctx, union, projection)}>([${variants}])`;
}

function emitDeclaredDiscriminatedUnionDecoder(
  ctx: EmitterCtx,
  dec: DecoderEmitContext,
  discriminated: DiscriminatedUnion,
  seenTypes: ReadonlySet<Type>,
  projection?: PayloadProjection,
  encodingTarget?: ModelProperty,
): string {
  const entries: string[] = [];
  let defaultVariant: string | undefined;

  for (const variant of discriminatedVariants(discriminated)) {
    const payloadTs = payloadTypeToTs(ctx, variant.type, projection);
    const variantTs = discriminatedVariantToTs(discriminated, variant, payloadTs);
    let decoder: string;

    if (discriminated.options.envelope === "object") {
      const payloadDecoder = emitDecoderExpression(
        ctx,
        dec,
        variant.type,
        "json",
        seenTypes,
        undefined,
        projection,
        encodingTarget,
      );
      decoder = `Decoders.object<${variantTs}>({ ${tsObjectKey(
        discriminated.options.discriminatorPropertyName,
      )}: ${emitSyntheticDiscriminatorDecoder(variant.tag)}, ${tsObjectKey(
        discriminated.options.envelopePropertyName,
      )}: ${payloadDecoder} }, { allowUnknown: true })`;
    } else if (variant.type.kind === "Model") {
      decoder = emitObjectDecoderBody(
        ctx,
        dec,
        variant.type,
        "json",
        new Set([...seenTypes, variant.type]),
        projection,
        {
          name: discriminated.options.discriminatorPropertyName,
          tag: variant.tag,
          typeTs: variantTs,
        },
      );
    } else {
      // The preflight diagnostic suppresses output for this invalid inline
      // shape. Keep a safe placeholder for callers that render despite errors.
      decoder = "Decoders.never";
    }

    if (variant.tag === undefined) {
      defaultVariant = decoder;
    } else {
      entries.push(`${tsObjectKey(variant.tag)}: ${decoder}`);
    }
  }

  const options = defaultVariant ? `, { defaultVariant: ${defaultVariant} }` : "";
  return `Decoders.discriminated<${payloadTypeToTs(
    ctx,
    discriminated.type,
    projection,
  )}>(${tsLiteral(discriminated.options.discriminatorPropertyName)}, { ${entries.join(
    ", ",
  )} }${options})`;
}

function getOrCreateLazyDecoder(
  dec: DecoderEmitContext,
  type: Model | Union,
  typeName: string,
  mode: DecoderMode,
  projection?: PayloadProjection,
): LazyDecoderEmission {
  let modes = dec.lazyDecoders.get(type);
  if (!modes) {
    modes = new Map();
    dec.lazyDecoders.set(type, modes);
  }

  const cacheKey = `${mode}:${projection?.cacheKey ?? "raw"}`;
  const existing = modes.get(cacheKey);
  if (existing) return existing;

  const modeName = mode === "json" ? "json" : `${mode[0]!.toUpperCase()}${mode.slice(1)}`;
  const modeSuffix = projection
    ? `${modeName}_${tsIdentifier(projection.cacheKey, "payload")}`
    : modeName;
  const baseVarName = `_lazy${dec.scopeName.length}_${dec.scopeName}_${typeName.length}_${typeName}_${modeSuffix}`;
  let varName = baseVarName;
  let suffix = 2;
  while (hasLazyDecoderVariable(dec, varName)) {
    varName = `${baseVarName}_${suffix}`;
    suffix += 1;
  }

  const emission: LazyDecoderEmission = { type, mode, projection, varName };
  modes.set(cacheKey, emission);
  return emission;
}

function hasLazyDecoderVariable(dec: DecoderEmitContext, varName: string): boolean {
  for (const modes of dec.lazyDecoders.values()) {
    for (const emission of modes.values()) {
      if (emission.varName === varName) return true;
    }
  }
  return false;
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
function emitStructuralDiscriminatedUnionDecoder(
  ctx: EmitterCtx,
  dec: DecoderEmitContext,
  union: Union,
  seenTypes: ReadonlySet<Type>,
): string | undefined {
  const models = discriminatableModels(ctx, union);
  if (!models) return undefined;

  const field =
    getDiscriminator(ctx.program, union)?.propertyName ?? inferCommonLiteralField(ctx, models);
  if (!field) return undefined;

  const wireFields = models.map((model) => {
    const property = [...walkPropertiesInherited(model)].find(
      (candidate) => candidate.name === field,
    );
    return property ? getJsonPropertyWireName(ctx, property) : undefined;
  });
  const [wireField] = wireFields;
  if (!wireField || wireFields.some((candidate) => candidate !== wireField)) return undefined;

  const entries: string[] = [];
  const tags = new Set<string>();
  for (const model of models) {
    const tag = literalTagValue(ctx, model, field);
    if (tag === undefined || tags.has(tag)) return undefined;
    tags.add(tag);
    entries.push(
      `${tsObjectKey(tag)}: ${emitDecoderExpression(ctx, dec, model, "json", seenTypes)}`,
    );
  }

  return `Decoders.discriminated<${typeToTs(ctx, union)}>(${tsLiteral(wireField)}, { ${entries.join(", ")} })`;
}

/** All variants as plain (non-array, non-pure-record) models, or undefined. */
function discriminatableModels(ctx: EmitterCtx, union: Union): Model[] | undefined {
  const types = [...union.variants.values()].map((variant) => variant.type);
  if (types.length < 2) return undefined;
  const models = types.filter(
    (type): type is Model =>
      type.kind === "Model" && !isArrayModelType(ctx.program, type) && !isPureRecordModel(type),
  );
  return models.length === types.length ? models : undefined;
}

/**
 * First property of the first variant that is a required literal in every
 * variant with values distinct across them.
 */
function inferCommonLiteralField(ctx: EmitterCtx, models: readonly Model[]): string | undefined {
  const [first, ...rest] = models;
  for (const prop of walkPropertiesInherited(first!)) {
    const value = literalTagValue(ctx, first!, prop.name);
    if (value === undefined) continue;
    const values = new Set([value]);
    const viable = rest.every((model) => {
      const tag = literalTagValue(ctx, model, prop.name);
      if (tag === undefined || values.has(tag)) return false;
      values.add(tag);
      return true;
    });
    if (viable) return prop.name;
  }
  return undefined;
}

/** The model's required literal value for `field`, stringified for tag lookup. */
function literalTagValue(ctx: EmitterCtx, model: Model, field: string): string | undefined {
  for (const prop of walkPropertiesInherited(model)) {
    if (prop.name !== field) continue;
    if (prop.optional) return undefined;
    if (!isStringLikeLiteral(prop.type) && prop.type.kind !== "Number") return undefined;
    return prop.type.kind === "Number"
      ? resolveNumericLiteral(prop.type).exactValue
      : getStringLiteralValue(prop.type);
  }
  return undefined;
}

/**
 * Builds hoisted `Decoders.lazy(() => ...)` declarations for any recursive named
 * types that were detected during decoder emission.
 */
export function buildHoistedDecoders(ctx: EmitterCtx, dec: DecoderEmitContext): string[] {
  // Expanding a lazy type from an empty traversal set emits its complete root
  // decoder while recursive edges resolve back to the already registered lazy
  // declaration. Expansion can discover additional cycles, so continue until
  // every registered semantic type/mode pair has been emitted.
  let lazy = nextUnemittedLazyDecoder(dec);
  while (lazy) {
    dec.emittedLazy.add(lazy);
    const tsType = payloadTypeToTs(ctx, lazy.type, lazy.projection);
    const expression = emitDecoderExpression(
      ctx,
      dec,
      lazy.type,
      lazy.mode,
      new Set(),
      undefined,
      lazy.projection,
    );
    dec.hoistedDecoderLines.push(
      `const ${lazy.varName}: Decoder<${tsType}> = Decoders.lazy(() => ${expression});`,
    );
    lazy = nextUnemittedLazyDecoder(dec);
  }
  return [...dec.hoistedDecoderLines];
}

function nextUnemittedLazyDecoder(dec: DecoderEmitContext): LazyDecoderEmission | undefined {
  for (const modes of dec.lazyDecoders.values()) {
    for (const emission of modes.values()) {
      if (!dec.emittedLazy.has(emission)) return emission;
    }
  }
  return undefined;
}

function emitEnumDecoder(ctx: EmitterCtx, enumType: Enum, mode: DecoderMode): string {
  const lit = mode === "json" ? "Decoders.strictLiteral" : "Decoders.literal";
  const members = [...enumType.members.values()].map((member) => {
    return `${lit}(${enumMemberLiteralExpression(ctx.program, member)})`;
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
