import type { Model, ModelProperty, Scalar, Type, Union } from "@typespec/compiler";
import {
  $encodedName,
  getDiscriminatedUnion,
  getEncode,
  isArrayModelType,
  isRecordModelType,
  resolveEncodedName,
  walkPropertiesInherited,
} from "@typespec/compiler";
import type { HttpOperation, HttpOperationParameter } from "@typespec/http";
import { getAuthenticationForOperation, isMetadata } from "@typespec/http";
import { getBodyMediaKinds, type BodyMediaKind } from "./body-media-kinds.js";
import type { EmitterCtx } from "./ctx.js";
import { $lib } from "./lib.js";
import { isTypeSpecNamespaceModel } from "./type-reference.js";

const VISIBILITY_DECORATOR_NAMES = new Set(["@visibility", "@invisible", "@removeVisibility"]);

interface ServiceDecoratorReports {
  readonly encodedNames: Set<ModelProperty>;
  readonly visibility: Set<ModelProperty>;
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
    visibility: new Set(),
    discriminated: new Set(),
  };
  let authReported = false;

  for (const operation of operations) {
    const traversal: OperationTraversal = {
      operation,
      seen: new Set(),
      encodes: new Set(),
    };

    if (!authReported && getAuthenticationForOperation(ctx.program, operation.operation)) {
      $lib.reportDiagnostic(ctx.program, {
        code: "ignored-auth",
        target: ctx.service.namespace,
      });
      authReported = true;
    }

    for (const parameter of operation.parameters.parameters) {
      checkHttpParameter(ctx, parameter);
      checkProperty(ctx, reported, traversal, parameter.param, parameter.param.name);
      walkType(ctx, reported, traversal, parameter.param.type, parameter.param.name);
    }
    checkRequestBody(ctx, reported, traversal);
    if (operation.parameters.body?.type) {
      walkType(ctx, reported, traversal, operation.parameters.body.type, "body");
    }
    for (const response of operation.responses) {
      walkType(ctx, reported, traversal, response.type, "response");
      for (const content of response.responses) {
        if (content.body?.type) {
          walkType(ctx, reported, traversal, content.body.type, "response");
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

  if (body.property) {
    checkProperty(ctx, reported, traversal, body.property, body.property.name);
  }

  if (body.bodyKind === "multipart") {
    for (const part of body.parts) {
      if (part.body.bodyKind === "file" || isWireScalarType(ctx, part.body.type)) continue;
      reportUnsupportedBody(
        ctx,
        traversal.operation,
        "multipart/form-data",
        "non-file parts may contain only scalar, literal, or enum values",
      );
      return;
    }
    return;
  }

  const contentTypes = body.contentTypes.length > 0 ? body.contentTypes : ["application/json"];
  for (const contentType of contentTypes) {
    for (const kind of getBodyMediaKinds([contentType])) {
      const reason = unsupportedBodyKindReason(ctx, body.type, kind);
      if (reason) {
        reportUnsupportedBody(ctx, traversal.operation, contentType, reason);
        break;
      }
    }
  }
}

function unsupportedBodyKindReason(
  ctx: EmitterCtx,
  type: Type,
  kind: BodyMediaKind,
): string | undefined {
  switch (kind) {
    case "json":
      return undefined;
    case "form":
      return isFlatFormBodyType(ctx, type)
        ? undefined
        : "URL-encoded forms require a flat model or record with scalar or scalar-array fields";
    case "text":
      return isWireScalarType(ctx, type)
        ? undefined
        : "text bodies require a scalar, literal, or enum type";
    case "binary":
      return isBytesScalar(type) ? undefined : "binary bodies require the TypeSpec bytes scalar";
    case "multipart":
      return "multipart content requires @multipartBody so parts can be decoded safely";
  }
}

function isFlatFormBodyType(ctx: EmitterCtx, type: Type): boolean {
  if (type.kind !== "Model" || isArrayModelType(ctx.program, type)) return false;
  if (isRecordModelType(ctx.program, type)) {
    return type.indexer !== undefined && isWireScalarOrArrayType(ctx, type.indexer.value);
  }
  return [...walkPropertiesInherited(type)].every(
    (property) => isMetadata(ctx.program, property) || isWireScalarOrArrayType(ctx, property.type),
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

function isBytesScalar(type: Type): boolean {
  if (type.kind !== "Scalar") return false;
  let current: Scalar | undefined = type;
  while (current) {
    if (current.namespace?.name === "TypeSpec") return current.name === "bytes";
    current = current.baseScalar;
  }
  return false;
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

function checkHttpParameter(ctx: EmitterCtx, parameter: HttpOperationParameter): void {
  const typeReason = unsupportedParameterTypeReason(ctx, parameter.param.type);
  if (typeReason) {
    reportUnsupportedParameter(ctx, parameter, typeReason);
    return;
  }

  if (parameter.type !== "path") return;

  if (parameter.style !== "simple") {
    reportUnsupportedParameter(
      ctx,
      parameter,
      `path style "${parameter.style}" cannot be matched by the generated router`,
    );
  } else if (parameter.allowReserved) {
    reportUnsupportedParameter(
      ctx,
      parameter,
      "allowReserved path values can contain route separators that the generated router cannot capture",
    );
  }
}

function unsupportedParameterTypeReason(ctx: EmitterCtx, type: Type): string | undefined {
  if (type.kind === "Model") {
    if (!isArrayModelType(ctx.program, type)) {
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
): void {
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
    case "UnionVariant":
    case "ModelProperty":
      walkType(ctx, reported, traversal, type.type, propertyPath);
      break;
    case "Tuple":
      for (const [index, value] of type.values.entries()) {
        walkType(ctx, reported, traversal, value, `${propertyPath}[${index}]`);
      }
      break;
    case "Scalar":
      checkScalarEncode(ctx, traversal, type, propertyPath);
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
  if (isArrayModelType(ctx.program, model) || isRecordModelType(ctx.program, model)) {
    if (model.indexer) {
      const elementPath = isArrayModelType(ctx.program, model)
        ? `${propertyPath}[]`
        : `${propertyPath}.*`;
      walkType(ctx, reported, traversal, model.indexer.value, elementPath);
    }
    return;
  }
  for (const property of walkPropertiesInherited(model)) {
    const nestedPath = `${propertyPath}.${property.name}`;
    checkProperty(ctx, reported, traversal, property, nestedPath);
    walkType(ctx, reported, traversal, property.type, nestedPath);
  }
}

function checkProperty(
  ctx: EmitterCtx,
  reported: ServiceDecoratorReports,
  traversal: OperationTraversal,
  property: ModelProperty,
  propertyPath: string,
): void {
  if (getEncode(ctx.program, property) && !traversal.encodes.has(property)) {
    traversal.encodes.add(property);
    $lib.reportDiagnostic(ctx.program, {
      code: "ignored-encode",
      format: {
        name: property.name,
        operation: traversal.operation.operation.name,
        property: propertyPath,
      },
      target: property,
    });
  }

  if (
    !reported.encodedNames.has(property) &&
    (property.decorators.some((decorator) => decorator.decorator === $encodedName) ||
      resolveEncodedName(ctx.program, property, "application/json") !== property.name)
  ) {
    reported.encodedNames.add(property);
    $lib.reportDiagnostic(ctx.program, {
      code: "ignored-encoded-name",
      format: { name: property.name },
      target: property,
    });
  }

  if (
    !reported.visibility.has(property) &&
    property.decorators.some((decorator) =>
      VISIBILITY_DECORATOR_NAMES.has(decorator.definition?.name ?? ""),
    )
  ) {
    reported.visibility.add(property);
    $lib.reportDiagnostic(ctx.program, {
      code: "ignored-visibility",
      format: { name: property.name },
      target: property,
    });
  }
}

function checkScalarEncode(
  ctx: EmitterCtx,
  traversal: OperationTraversal,
  scalar: Scalar,
  propertyPath: string,
): void {
  let current: Scalar | undefined = scalar;
  while (current) {
    if (getEncode(ctx.program, current)) {
      if (!traversal.encodes.has(current)) {
        traversal.encodes.add(current);
        $lib.reportDiagnostic(ctx.program, {
          code: "ignored-encode",
          format: {
            name: current.name,
            operation: traversal.operation.operation.name,
            property: propertyPath,
          },
          target: current,
        });
      }
      return;
    }
    current = current.baseScalar;
  }
}

function checkUnion(ctx: EmitterCtx, reported: ServiceDecoratorReports, union: Union): void {
  const [discriminated] = getDiscriminatedUnion(ctx.program, union);
  if (discriminated && !reported.discriminated.has(union)) {
    reported.discriminated.add(union);
    $lib.reportDiagnostic(ctx.program, {
      code: "ignored-discriminated",
      format: { name: union.name ?? "(anonymous)" },
      target: union,
    });
  }
}
