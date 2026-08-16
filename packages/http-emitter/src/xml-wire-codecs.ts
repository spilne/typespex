import type { Enum, Model, ModelProperty, Scalar, Type, Union } from "@typespec/compiler";
import { walkPropertiesInherited } from "@typespec/compiler";
import { getGeneratedTypeName, type EmitterCtx } from "./ctx.js";
import { emitDateTimeDecoder } from "./datetime-mode.js";
import { emitRequiredJsonWireSerializer } from "./json-wire-transforms.js";
import { getAdditionalPropertiesValue, isNeverAdditionalProperties } from "./model-indexer.js";
import { enumMemberLiteralExpression, numericLiteralExpression } from "./numeric-literals.js";
import {
  getPayloadCollection,
  payloadItemProjection,
  payloadModelProperties,
  payloadPropertyOptional,
  payloadTypeToTs,
  type PayloadProjection,
} from "./payload-context.js";
import { getIntrinsicScalarName } from "./scalar-map.js";
import { emitScalarEncodingDecoder, resolveScalarEncoding } from "./scalar-encoding.js";
import { stringLiteralExpression } from "./string-template-literals.js";
import { tsIdentifier, tsLiteral } from "./typescript-names.js";
import { decodedTypeKind, emitValidatorsForTarget } from "./validation-emission.js";
import {
  getXmlEncodedName,
  getXmlNamespace,
  isXmlAttribute,
  isXmlLeafType,
  isXmlUnwrapped,
  type XmlNamespaceMetadata,
} from "./xml-metadata.js";

interface XmlCodecEmission {
  readonly name: string;
  readonly type: Model | Union;
  readonly projection?: PayloadProjection;
  declaration?: string;
  building?: boolean;
}

interface XmlCodecState {
  readonly codecs: Map<Model | Union, Map<string, XmlCodecEmission>>;
  readonly usedNames: Set<string>;
}

const states = new WeakMap<EmitterCtx, XmlCodecState>();

export function emitXmlCodec(
  ctx: EmitterCtx,
  type: Type,
  projection?: PayloadProjection,
  target?: ModelProperty,
): string {
  if ((type.kind === "Model" || type.kind === "Union") && type.name) {
    return getOrCreateXmlCodec(ctx, type, projection).name;
  }
  return emitXmlCodecBody(ctx, type, projection, target);
}

export function getXmlCodecDeclarations(ctx: EmitterCtx): readonly string[] {
  const state = getState(ctx);
  let pending = nextPendingCodec(state);
  while (pending) {
    pending.building = true;
    const typeTs = payloadTypeToTs(ctx, pending.type, pending.projection);
    const body = emitXmlCodecBody(ctx, pending.type, pending.projection);
    pending.declaration =
      `const ${pending.name}: XmlCodec<${typeTs}> = ` + `XmlCodecs.lazy<${typeTs}>(() => ${body});`;
    pending.building = false;
    pending = nextPendingCodec(state);
  }

  return [...state.codecs.values()]
    .flatMap((byProjection) => [...byProjection.values()])
    .filter(
      (codec): codec is XmlCodecEmission & { declaration: string } =>
        codec.declaration !== undefined,
    )
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((codec) => codec.declaration);
}

function emitXmlCodecBody(
  ctx: EmitterCtx,
  type: Type,
  projection?: PayloadProjection,
  target?: ModelProperty,
): string {
  if (isXmlLeafType(type, new Set())) {
    return emitXmlScalarCodec(ctx, type, projection, target);
  }

  if (type.kind !== "Model") {
    return `XmlCodecs.scalar(${tsLiteral(xmlTypeName(ctx, type))}, Decoders.never, JsonSerializers.identity())`;
  }

  const collection = getPayloadCollection(ctx, type);
  if (collection?.kind === "array") {
    return `XmlCodecs.array(${tsLiteral(xmlTypeName(ctx, type))}, ${emitXmlCodec(
      ctx,
      collection.value,
      payloadItemProjection(projection),
    )}${emitXmlOptions(getXmlNamespace(ctx.program, type))})`;
  }
  if (collection?.kind === "record") {
    return `XmlCodecs.record(${tsLiteral(xmlTypeName(ctx, type))}, ${emitXmlCodec(
      ctx,
      collection.value,
      payloadItemProjection(projection),
    )}${emitXmlOptions(getXmlNamespace(ctx.program, type))})`;
  }

  const properties = payloadModelProperties(type, projection);
  const descriptors = properties.map((property) => emitXmlProperty(ctx, property, projection));
  const options: string[] = [];
  const namespace = getXmlNamespace(ctx.program, type);
  if (namespace) options.push(emitNamespaceOption(namespace));

  const additionalProperties = getAdditionalPropertiesValue(type);
  if (additionalProperties === undefined) {
    options.push("allowUnknown: true");
  } else if (!isNeverAdditionalProperties(type)) {
    options.push(
      `additionalProperties: ${emitXmlCodec(
        ctx,
        additionalProperties,
        payloadItemProjection(projection),
      )}`,
    );
  }

  if (projection) {
    const included = new Set(properties.map((property) => property.name));
    const forbiddenNames = [...walkPropertiesInherited(type)]
      .filter((property) => !included.has(property.name))
      .map((property) => getXmlEncodedName(ctx.program, property));
    if (forbiddenNames.length > 0) {
      options.push(`forbiddenNames: ${tsLiteral(forbiddenNames)}`);
    }
  }

  const optionsArg = options.length > 0 ? `, { ${options.join(", ")} }` : "";
  return `XmlCodecs.object<${payloadTypeToTs(ctx, type, projection)}>(${tsLiteral(
    xmlTypeName(ctx, type),
  )}, [${descriptors.join(", ")}]${optionsArg})`;
}

function emitXmlProperty(
  ctx: EmitterCtx,
  property: ModelProperty,
  projection?: PayloadProjection,
): string {
  const fields = [
    `property: ${tsLiteral(property.name)}`,
    `name: ${tsLiteral(getXmlEncodedName(ctx.program, property))}`,
    `codec: ${emitXmlCodec(ctx, property.type, projection, property)}`,
  ];
  if (payloadPropertyOptional(property, projection)) fields.push("optional: true");
  if (isXmlAttribute(ctx.program, property)) fields.push("attribute: true");
  if (isXmlUnwrapped(ctx.program, property)) fields.push("unwrapped: true");
  const namespace = getXmlNamespace(ctx.program, property);
  if (namespace) fields.push(emitNamespaceOption(namespace));
  return `{ ${fields.join(", ")} }`;
}

function emitXmlScalarCodec(
  ctx: EmitterCtx,
  type: Type,
  projection?: PayloadProjection,
  target?: ModelProperty,
): string {
  const typeTs = payloadTypeToTs(ctx, type, projection);
  const decoder = emitXmlLeafDecoder(ctx, type, target);
  const serializer = emitRequiredJsonWireSerializer(ctx, type, projection, target, "text");
  return `XmlCodecs.scalar<${typeTs}>(${tsLiteral(xmlTypeName(ctx, type))}, ${decoder}, ${serializer}${emitXmlOptions(
    getXmlNamespace(ctx.program, type),
  )})`;
}

function emitXmlLeafDecoder(ctx: EmitterCtx, type: Type, target?: ModelProperty): string {
  let expression: string;
  switch (type.kind) {
    case "Scalar":
      expression = emitXmlScalarDecoder(ctx, type, target);
      break;
    case "Enum":
      expression = emitXmlEnumDecoder(ctx, type);
      break;
    case "Union":
      expression = `Decoders.union<${payloadTypeToTs(ctx, type, undefined)}>([${[
        ...type.variants.values(),
      ]
        .map((variant) => emitXmlLeafDecoder(ctx, variant.type, target))
        .join(", ")}])`;
      break;
    case "String":
    case "StringTemplate":
      expression = `Decoders.literal(${stringLiteralExpression(type)})`;
      break;
    case "Number":
      expression = `Decoders.literal(${numericLiteralExpression(type)})`;
      break;
    case "Boolean":
      expression = `Decoders.literal(${String(type.value)})`;
      break;
    case "ModelProperty":
      return emitXmlLeafDecoder(ctx, type.type, type);
    case "UnionVariant":
      return emitXmlLeafDecoder(ctx, type.type, target);
    default:
      expression = "Decoders.never";
      break;
  }
  return applyXmlValidation(ctx, expression, type, target);
}

function emitXmlScalarDecoder(ctx: EmitterCtx, scalar: Scalar, target?: ModelProperty): string {
  const encoding = resolveScalarEncoding(ctx, scalar, target, "text");
  if (encoding.status === "supported") {
    const wireDecoder = applyXmlValidation(
      ctx,
      emitUnencodedXmlScalarDecoder(encoding.plan.wireType),
      encoding.plan.wireType,
    );
    return emitScalarEncodingDecoder(ctx, encoding.plan, wireDecoder);
  }
  return emitDateTimeDecoder(ctx, scalar, emitUnencodedXmlScalarDecoder(scalar));
}

function emitUnencodedXmlScalarDecoder(scalar: Scalar): string {
  switch (getIntrinsicScalarName(scalar)) {
    case "int8":
      return withNumericRange("Decoders.integer", "-128", "127");
    case "uint8":
      return withNumericRange("Decoders.integer", "0", "255");
    case "int16":
      return withNumericRange("Decoders.integer", "-32768", "32767");
    case "uint16":
      return withNumericRange("Decoders.integer", "0", "65535");
    case "int32":
      return withNumericRange("Decoders.integer", "-2147483648", "2147483647");
    case "uint32":
      return withNumericRange("Decoders.integer", "0", "4294967295");
    case "int64":
      return withNumericRange("Decoders.bigint", "-9223372036854775808n", "9223372036854775807n");
    case "uint64":
      return withNumericRange("Decoders.bigint", "0n", "18446744073709551615n");
    case "integer":
      return "Decoders.integer";
    case "safeint":
      return "Decoders.safeInteger";
    case "float32":
    case "float64":
    case "float":
    case "numeric":
    case "decimal":
    case "decimal128":
      return "Decoders.number";
    case "boolean":
      return "Decoders.boolean";
    case "bytes":
      return "Decoders.bytes";
    default:
      return "Decoders.string";
  }
}

function emitXmlEnumDecoder(ctx: EmitterCtx, type: Enum): string {
  const members = [...type.members.values()].map(
    (member) => `Decoders.literal(${enumMemberLiteralExpression(ctx.program, member)})`,
  );
  return `Decoders.union([${members.join(", ")}])`;
}

function applyXmlValidation(
  ctx: EmitterCtx,
  expression: string,
  type: Type,
  target?: ModelProperty,
): string {
  const validators = [
    ...emitValidatorsForTarget(ctx, type, decodedTypeKind(ctx, type)),
    ...(target ? emitValidatorsForTarget(ctx, target, decodedTypeKind(ctx, target.type)) : []),
  ];
  return validators.length > 0 ? `${expression}.validate(${validators.join(", ")})` : expression;
}

function withNumericRange(decoder: string, min: string, max: string): string {
  return `${decoder}.validate(Validators.minValue(${min}), Validators.maxValue(${max}))`;
}

function xmlTypeName(ctx: EmitterCtx, type: Type): string {
  switch (type.kind) {
    case "Model":
    case "Scalar":
    case "Enum":
      return type.name ? getXmlEncodedName(ctx.program, type) : type.kind;
    case "Union":
      return type.name ? getXmlEncodedName(ctx.program, type) : "value";
    case "String":
    case "StringTemplate":
      return "string";
    case "Number":
      return "number";
    case "Boolean":
      return "boolean";
    case "ModelProperty":
    case "UnionVariant":
      return xmlTypeName(ctx, type.type);
    default:
      return "value";
  }
}

function emitXmlOptions(namespace: XmlNamespaceMetadata | undefined): string {
  return namespace ? `, { ${emitNamespaceOption(namespace)} }` : "";
}

function emitNamespaceOption(namespace: XmlNamespaceMetadata): string {
  return `namespace: { prefix: ${tsLiteral(namespace.prefix)}, uri: ${tsLiteral(namespace.uri)} }`;
}

function getOrCreateXmlCodec(
  ctx: EmitterCtx,
  type: Model | Union,
  projection?: PayloadProjection,
): XmlCodecEmission {
  const state = getState(ctx);
  let projections = state.codecs.get(type);
  if (!projections) {
    projections = new Map();
    state.codecs.set(type, projections);
  }
  const key = projection?.cacheKey ?? "raw";
  const existing = projections.get(key);
  if (existing) return existing;

  const typeName = getGeneratedTypeName(ctx, type, type.kind === "Model" ? "Model" : "Union");
  const projectionName = projection ? tsIdentifier(projection.cacheKey, "payload") : "raw";
  const baseName = `_xml${typeName.length}_${typeName}_${projectionName}Codec`;
  let name = baseName;
  let suffix = 2;
  while (state.usedNames.has(name)) {
    name = `${baseName}_${suffix}`;
    suffix += 1;
  }
  state.usedNames.add(name);
  const emission: XmlCodecEmission = { name, type, projection };
  projections.set(key, emission);
  return emission;
}

function getState(ctx: EmitterCtx): XmlCodecState {
  let state = states.get(ctx);
  if (!state) {
    state = { codecs: new Map(), usedNames: new Set() };
    states.set(ctx, state);
  }
  return state;
}

function nextPendingCodec(state: XmlCodecState): XmlCodecEmission | undefined {
  for (const projections of state.codecs.values()) {
    for (const codec of projections.values()) {
      if (!codec.declaration && !codec.building) return codec;
    }
  }
  return undefined;
}
