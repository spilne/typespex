/**
 * Composes route parameters and request bodies into generated server input decoders.
 */
import type {
  HttpOperation,
  HttpOperationMultipartBody,
  HttpOperationParameter,
  HttpOperationPart,
} from "@typespec/http";
import type { Model, Type } from "@typespec/compiler";
import { isArrayModelType } from "@typespec/compiler";
import {
  getBodyMediaKinds,
  getMultipartPartMediaKinds,
  type BodyMediaKind,
} from "./body-media-kinds.js";
import type { EmitterCtx } from "./ctx.js";
import { buildInputType } from "./server-input-types.js";
import { propertiesShareSource } from "./http-models.js";
import { getExplodedQueryModelProperties, isExplodedQueryRecord } from "./http-parameter-shapes.js";
import { multipartBodyTypeToTs } from "./multipart-input.js";
import { getSameEndpointOverloads } from "./operation-surface.js";
import {
  getPayloadCollection,
  getRequestBodyProjection,
  payloadProjectionChangesType,
  payloadTypeToTs,
  type PayloadProjection,
} from "./payload-context.js";
import { getRequestInputPlan, type RequestBodyInputPlan } from "./request-input-plan.js";
import { getHandlerRequestParameters, getJsonlRequestStream } from "./request-streams.js";
import {
  buildHoistedDecoders,
  createDecoderEmitContext,
  emitDecoderExpression,
  type DecoderEmitContext,
  type DecoderMode,
} from "./server-value-decoders.js";
import { typeToTs } from "./type-reference.js";
import { lowerUriTemplate } from "./uri-template.js";
import {
  isTsIdentifier,
  tsLiteral,
  tsObjectKey,
  tsPropertyAccess,
  tsPropertyDeclaration,
} from "./typescript-names.js";
import { emitXmlCodec } from "./xml-wire-codecs.js";

const SERVER_INPUT_DECODER_IMPORTS = [
  "Decoders",
  "RequestDecoders",
  "Validators",
  "decodeRequestInput",
  "decodeRequestInputAndBody",
  "decodeBody",
] as const;

export function getServerInputDecoderImports(
  ctx: EmitterCtx,
  operations: readonly HttpOperation[],
): readonly string[] {
  let needsJsonlBody = false;
  let needsCombinedJsonlBody = false;
  for (const operation of operations) {
    if (!getJsonlRequestStream(ctx, operation)) continue;
    if (getHandlerRequestParameters(ctx, operation).length === 0) needsJsonlBody = true;
    else needsCombinedJsonlBody = true;
  }

  return [
    ...SERVER_INPUT_DECODER_IMPORTS,
    ...(needsJsonlBody ? ["decodeJsonlBody"] : []),
    ...(needsCombinedJsonlBody ? ["decodeRequestInputAndJsonlBody"] : []),
  ];
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
  const parameters = getHandlerRequestParameters(ctx, op);
  const pathParams = parameters.filter((p) => p.type === "path");
  const queryParams = parameters.filter((p) => p.type === "query");
  const loweredUriTemplate = lowerUriTemplate(op);
  const literalQueryNames = loweredUriTemplate.ok
    ? (loweredUriTemplate.value.literalQuery?.map(({ name }) => name) ?? [])
    : [];
  const headerParams = parameters.filter((p) => p.type === "header");
  const cookieParams = parameters.filter((p) => p.type === "cookie");
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
          ...new Set([
            ...literalQueryNames,
            ...queryParams
              .filter((candidate) => candidate !== param)
              .flatMap((candidate) => queryParameterClaimedNames(ctx, candidate)),
          ]),
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

  const requestStream = getJsonlRequestStream(ctx, op);
  if (requestStream) {
    const projection = getEffectiveRequestStreamProjection(ctx, op, requestStream.streamType);
    const itemType = payloadTypeToTs(ctx, requestStream.streamType, projection);
    const bodyEntry = emitJsonlBodyDecoderEntry(
      hasRequestInput ? `${opName}Body` : opName,
      ctx,
      dec,
      requestStream.streamType,
      projection,
    );
    const bodyOptionsArg = emitJsonlBodyOptionsArg(
      requestStream.contentTypes,
      op.parameters.body?.contentTypeProperty?.optional === true,
    );

    if (!hasRequestInput) {
      return {
        inputEntries: [bodyEntry],
        decodeExpression: `decodeJsonlBody<${itemType}>(request, ${tsPropertyAccess(inputsRef, opName)}${bodyOptionsArg})`,
        needsPathParams: false,
        isAsync: true,
        hoistedDecoders: buildHoistedDecoders(ctx, dec),
      };
    }

    const requestRef = tsPropertyAccess(inputsRef, `${opName}Request`);
    const bodyRef = tsPropertyAccess(inputsRef, `${opName}Body`);
    const requestType = buildRequestOnlyType(ctx, op);
    const bodyPlan = getRequestInputPlan(ctx, op).body;
    const bodyProperty = bodyPlan?.placement === "wrapped" ? bodyPlan.propertyName : "body";
    return {
      inputEntries: [emitRequestDecoderEntry(`${opName}Request`, requestEntries), bodyEntry],
      decodeExpression: `decodeRequestInputAndJsonlBody<${requestType}, ${itemType}, ${tsLiteral(bodyProperty)}>(${requestRef}, ${bodyRef}, ${tsLiteral(bodyProperty)}, request, pathParams${bodyOptionsArg})`,
      needsPathParams: true,
      isAsync: true,
      hoistedDecoders: buildHoistedDecoders(ctx, dec),
    };
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

function emitJsonlBodyDecoderEntry(
  name: string,
  ctx: EmitterCtx,
  dec: DecoderEmitContext,
  streamType: Type,
  projection?: PayloadProjection,
): InputDecoderEntry {
  const decoder = emitDecoderExpression(
    ctx,
    dec,
    streamType,
    "json",
    new Set(),
    undefined,
    projection,
  );
  return { lines: [`  ${tsObjectKey(name)}: ${decoder},`] };
}

function emitJsonlBodyOptionsArg(
  contentTypes: readonly string[],
  allowMissingContentType: boolean,
): string {
  const options = [
    `contentTypes: [${contentTypes.map((contentType) => tsLiteral(contentType)).join(", ")}]`,
  ];
  if (allowMissingContentType) options.push("allowMissingContentType: true");
  return `, { ${options.join(", ")} }`;
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
  if (kind === "xml") {
    return emitXmlCodec(ctx, body.type, getEffectiveRequestBodyProjection(ctx, op), body.property);
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

  const supported = getMultipartPartMediaKinds(part.body.contentTypes);
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

function getEffectiveRequestStreamProjection(
  ctx: EmitterCtx,
  op: HttpOperation,
  streamType: Type,
): PayloadProjection | undefined {
  const projection = getRequestBodyProjection(ctx, op);
  return payloadProjectionChangesType(ctx, streamType, projection) ? projection : undefined;
}

function buildRequestOnlyType(ctx: EmitterCtx, op: HttpOperation): string {
  const parts: string[] = [];
  for (const param of getHandlerRequestParameters(ctx, op)) {
    parts.push(
      tsPropertyDeclaration(param.param.name, typeToTs(ctx, param.param.type), {
        optional: param.param.optional,
      }),
    );
  }
  if (parts.length === 0) return "Record<string, never>";
  return `{ ${parts.join("; ")} }`;
}
