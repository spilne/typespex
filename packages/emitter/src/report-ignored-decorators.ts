import type {
  DiscriminatedUnion,
  Model,
  ModelProperty,
  Scalar,
  Type,
  Union,
} from "@typespec/compiler";
import { isArrayModelType, resolveEncodedName, walkPropertiesInherited } from "@typespec/compiler";
import type { HttpOperation, HttpOperationParameter } from "@typespec/http";
import { getBodyMediaKinds, normalizeMediaType, type BodyMediaKind } from "./body-media-kinds.js";
import type { EmitterCtx } from "./ctx.js";
import { discriminatedVariants, resolveDiscriminatedUnion } from "./discriminated-unions.js";
import { propertiesShareSource } from "./http-models.js";
import { $lib } from "./lib.js";
import {
  getAdditionalPropertiesValue,
  isNeverAdditionalProperties,
  isPureRecordModel,
} from "./model-indexer.js";
import { getSameEndpointOverloads } from "./operation-surface.js";
import {
  getPayloadCollection,
  getRequestBodyProjection,
  payloadItemProjection,
  payloadModelProperties,
  type PayloadProjection,
} from "./payload-context.js";
import { isTypeSpecNamespaceModel } from "./type-reference.js";
import { isBytesScalar, unsupportedFileContentsReason } from "./wire-types.js";
import { resolveScalarEncoding } from "./scalar-encoding.js";
import { lowerUriTemplate } from "./uri-template.js";

interface ServiceDecoratorReports {
  readonly encodedNames: Set<ModelProperty>;
  readonly discriminated: Set<Union>;
}

interface OperationTraversal {
  readonly operation: HttpOperation;
  readonly seen: Set<Type>;
  readonly encodes: Set<ModelProperty | Scalar>;
}

/** Preflights HTTP contracts and reports unsupported wire semantics before file emission. */
export function reportIgnoredDecorators(
  ctx: EmitterCtx,
  operations: readonly HttpOperation[],
): void {
  const reported: ServiceDecoratorReports = {
    encodedNames: new Set(),
    discriminated: new Set(),
  };
  for (const operation of operations) {
    const traversal: OperationTraversal = {
      operation,
      seen: new Set(),
      encodes: new Set(),
    };

    for (const parameter of operation.parameters.parameters) {
      checkHttpParameter(ctx, operation, parameter);
      walkType(
        ctx,
        reported,
        traversal,
        parameter.param.type,
        parameter.param.name,
        parameter.param,
      );
    }
    checkRequestBody(ctx, reported, traversal);
    if (operation.parameters.body?.type) {
      walkType(
        ctx,
        reported,
        traversal,
        operation.parameters.body.type,
        "body",
        operation.parameters.body.property,
      );
    }
    for (const response of operation.responses) {
      walkType(ctx, reported, traversal, response.type, "response");
      for (const content of response.responses) {
        if (content.body?.type) {
          walkType(ctx, reported, traversal, content.body.type, "response", content.body.property);
        }
      }
    }
  }
}

function checkRequestBody(
  ctx: EmitterCtx,
  reported: ServiceDecoratorReports,
  traversal: OperationTraversal,
): void {
  const body = traversal.operation.parameters.body;
  if (!body) return;
  if (!requestBodyContentTypesAreValid(ctx, traversal.operation, body.contentTypes)) return;

  const overloads = getSameEndpointOverloads(traversal.operation).filter(
    (operation) => operation.parameters.body !== undefined,
  );
  if (overloads.length > 0) {
    for (const operation of overloads) {
      checkRequestBody(ctx, reported, {
        operation,
        seen: new Set(),
        encodes: new Set(),
      });
    }
    const coveredKinds = new Set(overloads.flatMap(requestBodyDecoderKinds));
    if (requestBodyDecoderKinds(traversal.operation).every((kind) => coveredKinds.has(kind))) {
      return;
    }
  }

  if (body.bodyKind === "file") {
    const constraintReason = unsupportedFileContentsReason(ctx.program, body);
    if (constraintReason) {
      reportUnsupportedBody(
        ctx,
        traversal.operation,
        body.contentTypes.join(", ") || "*/*",
        constraintReason,
      );
    }

    const hasFilenameInput = traversal.operation.parameters.parameters.some((parameter) =>
      propertiesShareSource(parameter.param, body.filename),
    );
    if (!body.filename.optional && !hasFilenameInput) {
      reportUnsupportedBody(
        ctx,
        traversal.operation,
        body.contentTypes.join(", ") || "*/*",
        "a required File.filename needs an explicit path, query, or header location in requests",
      );
    }
    return;
  }

  if (body.bodyKind === "multipart") {
    if (body.multipartKind === "model") {
      const wireNames = new Map<string, string>();
      for (const part of body.parts) {
        const previous = wireNames.get(part.name);
        if (previous !== undefined) {
          reportUnsupportedBody(
            ctx,
            traversal.operation,
            body.contentTypes.join(", ") || "multipart/form-data",
            `multipart properties "${previous}" and "${part.property.name}" share wire part name "${part.name}"`,
          );
          return;
        }
        wireNames.set(part.name, part.property.name);
      }
    }

    for (const [index, part] of body.parts.entries()) {
      const partLabel = part.name ?? `#${index + 1}`;
      const fileName = part.body.bodyKind === "file" ? part.filename : undefined;
      const unsupportedHeader = part.headers.find(
        (header) => !fileName || !propertiesShareSource(header.property, fileName),
      );
      if (unsupportedHeader) {
        reportUnsupportedBody(
          ctx,
          traversal.operation,
          body.contentTypes.join(", ") || "multipart/form-data",
          `multipart part "${partLabel}" declares header "${unsupportedHeader.options.name}", but only a File filename header can currently be represented`,
        );
        return;
      }
      if (
        !requestBodyContentTypesAreValid(
          ctx,
          traversal.operation,
          part.body.contentTypes,
          `multipart part "${partLabel}"`,
        )
      ) {
        return;
      }

      if (part.body.bodyKind === "file") {
        const constraintReason = unsupportedFileContentsReason(ctx.program, part.body);
        if (constraintReason) {
          reportUnsupportedBody(
            ctx,
            traversal.operation,
            body.contentTypes.join(", ") || "multipart/form-data",
            constraintReason,
          );
          return;
        }
        continue;
      }

      for (const contentType of part.body.contentTypes) {
        for (const kind of getBodyMediaKinds([contentType])) {
          const encodingReason = unsupportedBinaryScalarEncodingReason(
            ctx,
            part.body.type,
            part.body.property,
            kind,
          );
          const reason =
            encodingReason ??
            (kind === "form" || kind === "multipart" || kind === "file"
              ? "multipart parts support JSON, text, binary, or File content"
              : unsupportedBodyKindReason(ctx, part.body.type, kind));
          if (reason) {
            reportUnsupportedBody(
              ctx,
              traversal.operation,
              contentType,
              `multipart part "${partLabel}": ${reason}`,
            );
            return;
          }
        }
      }
    }
    return;
  }

  const contentTypes = body.contentTypes.length > 0 ? body.contentTypes : ["application/json"];
  const projection = getRequestBodyProjection(ctx, traversal.operation);
  for (const contentType of contentTypes) {
    for (const kind of getBodyMediaKinds([contentType])) {
      if (kind === "form") {
        reportUnsupportedEncodedNames(ctx, reported, body.type, contentType, projection, new Set());
      }
      const reason =
        unsupportedBinaryScalarEncodingReason(ctx, body.type, body.property, kind) ??
        unsupportedBodyKindReason(ctx, body.type, kind, projection);
      if (reason) {
        reportUnsupportedBody(ctx, traversal.operation, contentType, reason);
        break;
      }
    }
  }
}

function requestBodyDecoderKinds(operation: HttpOperation): BodyMediaKind[] {
  const body = operation.parameters.body;
  if (!body) return [];
  if (body.bodyKind === "file") return ["file"];
  if (body.bodyKind === "multipart") return ["multipart"];
  return getBodyMediaKinds(body.contentTypes.length > 0 ? body.contentTypes : ["application/json"]);
}

function unsupportedBinaryScalarEncodingReason(
  ctx: EmitterCtx,
  type: Type,
  target: ModelProperty | undefined,
  kind: BodyMediaKind,
): string | undefined {
  if (kind !== "binary" || type.kind !== "Scalar") return undefined;
  const encoding = resolveScalarEncoding(ctx, type, target, "binary");
  return encoding.status === "supported"
    ? `binary bodies cannot apply scalar encoding ${JSON.stringify(encoding.plan.encoding)}; use a textual or JSON media type`
    : undefined;
}

function requestBodyContentTypesAreValid(
  ctx: EmitterCtx,
  operation: HttpOperation,
  contentTypes: readonly string[],
  context?: string,
): boolean {
  for (const contentType of contentTypes) {
    if (normalizeMediaType(contentType)) continue;
    const prefix = context ? `${context}: ` : "";
    reportUnsupportedBody(
      ctx,
      operation,
      contentType,
      `${prefix}content type must be a valid type/subtype media type`,
    );
    return false;
  }
  return true;
}

function unsupportedBodyKindReason(
  ctx: EmitterCtx,
  type: Type,
  kind: BodyMediaKind,
  projection?: PayloadProjection,
): string | undefined {
  switch (kind) {
    case "json":
      return undefined;
    case "form":
      return isFlatFormBodyType(ctx, type, projection)
        ? undefined
        : "URL-encoded forms require a flat model or record with scalar or scalar-array fields";
    case "text":
      return isWireScalarType(ctx, type)
        ? undefined
        : "text bodies require a scalar, literal, or enum type";
    case "binary":
      return isBytesScalar(type) ? undefined : "binary bodies require the TypeSpec bytes scalar";
    case "file":
      return "raw file content requires a resolved TypeSpec HTTP File body";
    case "multipart":
      return "multipart content requires @multipartBody so parts can be decoded safely";
  }
}

function isFlatFormBodyType(ctx: EmitterCtx, type: Type, projection?: PayloadProjection): boolean {
  if (type.kind !== "Model" || isArrayModelType(ctx.program, type)) return false;
  const additionalProperties = getAdditionalPropertiesValue(type);
  if (
    additionalProperties !== undefined &&
    !isNeverAdditionalProperties(type) &&
    !isWireScalarOrArrayType(ctx, additionalProperties)
  ) {
    return false;
  }
  return payloadModelProperties(type, projection).every((property) =>
    isWireScalarOrArrayType(ctx, property.type),
  );
}

function isWireScalarOrArrayType(ctx: EmitterCtx, type: Type): boolean {
  if (isWireScalarType(ctx, type)) return true;
  return (
    type.kind === "Model" &&
    isArrayModelType(ctx.program, type) &&
    type.indexer !== undefined &&
    isWireScalarType(ctx, type.indexer.value)
  );
}

function reportUnsupportedBody(
  ctx: EmitterCtx,
  operation: HttpOperation,
  contentType: string,
  reason: string,
): void {
  $lib.reportDiagnostic(ctx.program, {
    code: "unsupported-request-body",
    format: { operation: operation.operation.name, contentType, reason },
    target: operation.parameters.body?.property ?? operation.operation,
  });
}

function checkHttpParameter(
  ctx: EmitterCtx,
  operation: HttpOperation,
  parameter: HttpOperationParameter,
): void {
  const typeReason = unsupportedParameterTypeReason(ctx, parameter);
  if (typeReason) {
    reportUnsupportedParameter(ctx, parameter, typeReason);
    return;
  }

  if (parameter.type !== "path") return;

  if (parameter.style !== "simple" && !isSupportedNonSimplePathParameter(operation, parameter)) {
    reportUnsupportedParameter(
      ctx,
      parameter,
      `path style "${parameter.style}" cannot be matched by the generated router`,
    );
  } else if (parameter.allowReserved && !isSupportedReservedPathParameter(operation, parameter)) {
    reportUnsupportedParameter(
      ctx,
      parameter,
      "allowReserved path values require one required scalar in a complete terminal path segment",
    );
  }
}

function isSupportedReservedPathParameter(
  operation: HttpOperation,
  parameter: HttpOperationParameter,
): boolean {
  if (parameter.type !== "path") return false;
  const lowered = lowerUriTemplate(operation);
  return lowered.ok && lowered.value.reservedExpandedPathNames?.includes(parameter.name) === true;
}

function isSupportedNonSimplePathParameter(
  operation: HttpOperation,
  parameter: HttpOperationParameter,
): boolean {
  if (parameter.type !== "path") return false;
  const lowered = lowerUriTemplate(operation);
  if (!lowered.ok) return false;
  switch (parameter.style) {
    case "path":
      return lowered.value.slashExpandedPathNames?.includes(parameter.name) === true;
    case "label":
      return lowered.value.labelExpandedPathNames?.includes(parameter.name) === true;
    case "matrix":
      return lowered.value.matrixExpandedPathNames?.includes(parameter.name) === true;
    default:
      return false;
  }
}

function unsupportedParameterTypeReason(
  ctx: EmitterCtx,
  parameter: HttpOperationParameter,
): string | undefined {
  const type = parameter.param.type;
  if (type.kind === "Model") {
    if (!isArrayModelType(ctx.program, type)) {
      const collection = getPayloadCollection(ctx, type);
      if (collection?.kind === "record") {
        if (!isWireScalarType(ctx, collection.value)) {
          return "records may contain only scalar, literal, or enum values";
        }
        if (
          parameter.type === "path" &&
          (parameter.style === "simple" || parameter.style === "path")
        ) {
          return undefined;
        }
      }
      return "object and record values require location-specific serialization that is not implemented";
    }
    if (!type.indexer || !isWireScalarType(ctx, type.indexer.value)) {
      return "arrays may contain only scalar, literal, or enum values";
    }
    return undefined;
  }

  if (type.kind === "Tuple") {
    return "tuple values require a serialization style that is not implemented";
  }

  if (
    type.kind === "Union" &&
    [...type.variants.values()].some((variant) => !isWireScalarType(ctx, variant.type))
  ) {
    return "unions in HTTP parameters may contain only scalar, literal, or enum values";
  }

  return undefined;
}

function isWireScalarType(ctx: EmitterCtx, type: Type): boolean {
  switch (type.kind) {
    case "Scalar":
    case "Enum":
    case "String":
    case "StringTemplate":
    case "Number":
    case "Boolean":
    case "Intrinsic":
      return true;
    case "Union":
      return [...type.variants.values()].every((variant) => isWireScalarType(ctx, variant.type));
    case "UnionVariant":
    case "ModelProperty":
      return isWireScalarType(ctx, type.type);
    case "Model":
      return false;
    default:
      return false;
  }
}

function reportUnsupportedParameter(
  ctx: EmitterCtx,
  parameter: HttpOperationParameter,
  reason: string,
): void {
  $lib.reportDiagnostic(ctx.program, {
    code: "unsupported-http-parameter",
    format: {
      location: parameter.type,
      name: parameter.param.name,
      reason,
    },
    target: parameter.param,
  });
}

function walkType(
  ctx: EmitterCtx,
  reported: ServiceDecoratorReports,
  traversal: OperationTraversal,
  type: Type,
  propertyPath: string,
  target?: ModelProperty,
): void {
  if (type.kind === "Scalar") {
    checkScalarEncode(ctx, traversal, type, propertyPath, target);
    return;
  }
  if (traversal.seen.has(type)) return;
  traversal.seen.add(type);

  switch (type.kind) {
    case "Model":
      walkModel(ctx, reported, traversal, type, propertyPath);
      break;
    case "Union":
      checkUnion(ctx, reported, type);
      for (const variant of type.variants.values()) {
        walkType(ctx, reported, traversal, variant.type, propertyPath);
      }
      break;
    case "ModelProperty":
      walkType(ctx, reported, traversal, type.type, propertyPath, type);
      break;
    case "UnionVariant":
      walkType(ctx, reported, traversal, type.type, propertyPath);
      break;
    case "Tuple":
      for (const [index, value] of type.values.entries()) {
        walkType(ctx, reported, traversal, value, `${propertyPath}[${index}]`);
      }
      break;
    default:
      break;
  }
}

function walkModel(
  ctx: EmitterCtx,
  reported: ServiceDecoratorReports,
  traversal: OperationTraversal,
  model: Model,
  propertyPath: string,
): void {
  if (isTypeSpecNamespaceModel(model)) return;
  if (isArrayModelType(ctx.program, model)) {
    if (model.indexer) {
      walkType(ctx, reported, traversal, model.indexer.value, `${propertyPath}[]`);
    }
    return;
  }
  const additionalProperties = getAdditionalPropertiesValue(model);
  if (isPureRecordModel(model)) {
    if (additionalProperties) {
      walkType(ctx, reported, traversal, additionalProperties, `${propertyPath}.*`);
    }
    return;
  }
  for (const property of walkPropertiesInherited(model)) {
    const nestedPath = `${propertyPath}.${property.name}`;
    walkType(ctx, reported, traversal, property.type, nestedPath, property);
  }
  if (additionalProperties && !isNeverAdditionalProperties(model)) {
    walkType(ctx, reported, traversal, additionalProperties, `${propertyPath}.*`);
  }
}

function reportUnsupportedEncodedNames(
  ctx: EmitterCtx,
  reported: ServiceDecoratorReports,
  type: Type,
  contentType: string,
  projection: PayloadProjection | undefined,
  seen: Set<Type>,
): void {
  if (seen.has(type)) return;
  seen.add(type);

  switch (type.kind) {
    case "Model": {
      if (isArrayModelType(ctx.program, type)) {
        if (type.indexer) {
          reportUnsupportedEncodedNames(
            ctx,
            reported,
            type.indexer.value,
            contentType,
            projection,
            seen,
          );
        }
        return;
      }
      const additional = getAdditionalPropertiesValue(type);
      if (isPureRecordModel(type)) {
        if (additional) {
          reportUnsupportedEncodedNames(ctx, reported, additional, contentType, projection, seen);
        }
        return;
      }
      for (const property of payloadModelProperties(type, projection)) {
        if (
          resolveEncodedName(ctx.program, property, contentType) !== property.name &&
          !reported.encodedNames.has(property)
        ) {
          reported.encodedNames.add(property);
          $lib.reportDiagnostic(ctx.program, {
            code: "ignored-encoded-name",
            format: { name: property.name },
            target: property,
          });
        }
        reportUnsupportedEncodedNames(ctx, reported, property.type, contentType, projection, seen);
      }
      if (additional && !isNeverAdditionalProperties(type)) {
        reportUnsupportedEncodedNames(
          ctx,
          reported,
          additional,
          contentType,
          payloadItemProjection(projection),
          seen,
        );
      }
      return;
    }
    case "Union":
      for (const variant of type.variants.values()) {
        reportUnsupportedEncodedNames(ctx, reported, variant.type, contentType, projection, seen);
      }
      return;
    case "Tuple":
      for (const value of type.values) {
        reportUnsupportedEncodedNames(
          ctx,
          reported,
          value,
          contentType,
          payloadItemProjection(projection),
          seen,
        );
      }
      return;
    case "ModelProperty":
    case "UnionVariant":
      reportUnsupportedEncodedNames(ctx, reported, type.type, contentType, projection, seen);
      return;
    default:
      return;
  }
}

function checkScalarEncode(
  ctx: EmitterCtx,
  traversal: OperationTraversal,
  scalar: Scalar,
  propertyPath: string,
  target?: ModelProperty,
): void {
  const encoding = resolveScalarEncoding(ctx, scalar, target);
  if (encoding.status !== "unsupported" || traversal.encodes.has(encoding.source)) return;
  traversal.encodes.add(encoding.source);
  $lib.reportDiagnostic(ctx.program, {
    code: "unsupported-scalar-encoding",
    format: {
      encoding: encoding.encoding,
      name: encoding.source.name,
      reason: `${encoding.reason}; operation ${JSON.stringify(
        traversal.operation.operation.name,
      )} uses it at ${JSON.stringify(propertyPath)}`,
    },
    target: encoding.source,
  });
}

function checkUnion(ctx: EmitterCtx, reported: ServiceDecoratorReports, union: Union): void {
  const discriminated = resolveDiscriminatedUnion(ctx.program, union);
  if (!discriminated || reported.discriminated.has(union)) return;

  const reason = unsupportedDiscriminatedUnionReason(ctx, discriminated);
  if (!reason) return;
  reported.discriminated.add(union);
  $lib.reportDiagnostic(ctx.program, {
    code: "unsupported-discriminated-union",
    format: { name: union.name ?? "(anonymous)", reason },
    target: union,
  });
}

function unsupportedDiscriminatedUnionReason(
  ctx: EmitterCtx,
  discriminated: DiscriminatedUnion,
): string | undefined {
  const { discriminatorPropertyName, envelope, envelopePropertyName } = discriminated.options;
  if (envelope === "object" && discriminatorPropertyName === envelopePropertyName) {
    return `discriminator and envelope properties both use ${JSON.stringify(discriminatorPropertyName)}`;
  }
  if (envelope !== "none") return undefined;

  for (const variant of discriminatedVariants(discriminated)) {
    const label = variant.tag === undefined ? "default" : JSON.stringify(variant.tag);
    if (variant.type.kind !== "Model") {
      return `inline ${label} variant must be an object model, but it is ${variant.type.kind}`;
    }
    if (isArrayModelType(ctx.program, variant.type)) {
      return `inline ${label} variant is an array model and cannot receive discriminator property ${JSON.stringify(discriminatorPropertyName)}`;
    }

    for (const property of walkPropertiesInherited(variant.type)) {
      const wireName = resolveEncodedName(ctx.program, property, "application/json");
      if (property.name === discriminatorPropertyName && wireName !== discriminatorPropertyName) {
        return `inline ${label} discriminator property is encoded as ${JSON.stringify(wireName)} instead of ${JSON.stringify(discriminatorPropertyName)}`;
      }
      if (property.name !== discriminatorPropertyName && wireName === discriminatorPropertyName) {
        return `inline ${label} property ${JSON.stringify(property.name)} uses the discriminator wire name ${JSON.stringify(discriminatorPropertyName)}`;
      }
    }
  }
  return undefined;
}
