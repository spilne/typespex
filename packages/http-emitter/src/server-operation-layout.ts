/**
 * Discovers model dependencies and groups HTTP operations for server emission.
 */
import type { Interface, Type } from "@typespec/compiler";
import { isArrayModelType, isType, walkPropertiesInherited } from "@typespec/compiler";
import type { HttpOperation } from "@typespec/http";
import { getStreamMetadata } from "@typespec/http/experimental";
import {
  allocateGeneratedNames,
  getGeneratedTypeName,
  getNamespaceFullName,
  getRelativeNamespaceSegments,
  hasGeneratedTypeNameCollision,
  type EmitterCtx,
} from "./ctx.js";
import { getHttpPartType, isHttpFileModel } from "./http-models.js";
import { getAdditionalPropertiesValue, isPureRecordModel } from "./model-indexer.js";
import { isEntityLike } from "./type-guards.js";
import {
  isNamedUnionReference,
  isTemplatedScalarReference,
  isTypeSpecNamespaceModel,
} from "./type-reference.js";
import { tsIdentifier } from "./typescript-names.js";

export interface OperationGroup {
  interfaceName?: string;
  propertyName: string;
  exportName: string;
  operations: HttpOperation[];
}

export function collectModelImports(ctx: EmitterCtx, operations: HttpOperation[]): string[] {
  const names = new Set<string>();
  for (const op of operations) {
    collectTypeNames(ctx, op, names);
  }
  return [...names].filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)).sort();
}

function collectTypeNames(ctx: EmitterCtx, op: HttpOperation, names: Set<string>): void {
  for (const param of op.parameters.parameters) {
    addModelName(ctx, param.param.type, names, new Set());
  }

  if (op.parameters.body?.type) {
    addModelName(ctx, op.parameters.body.type, names, new Set());
  }
  const requestStream = getStreamMetadata(ctx.program, op.parameters);
  if (requestStream) {
    addModelName(ctx, requestStream.streamType, names, new Set());
  }

  addModelName(ctx, op.operation.returnType, names, new Set());

  for (const resp of op.responses) {
    addModelName(ctx, resp.type, names, new Set());
    for (const respBody of resp.responses) {
      const responseStream = getStreamMetadata(ctx.program, respBody);
      if (responseStream) {
        addModelName(ctx, responseStream.streamType, names, new Set());
      }
      if (respBody.body?.type) {
        addModelName(ctx, respBody.body.type, names, new Set());
      }
    }
  }
}

function addModelName(ctx: EmitterCtx, type: Type, names: Set<string>, seen: Set<Type>): void {
  if (seen.has(type)) return;
  seen.add(type);

  if (type.kind === "Model") {
    if (isArrayModelType(ctx.program, type)) {
      if (type.indexer) {
        addModelName(ctx, type.indexer.value, names, seen);
      }
      return;
    }
    if (isPureRecordModel(type)) {
      const additionalType = getAdditionalPropertiesValue(type);
      if (additionalType) addModelName(ctx, additionalType, names, seen);
      return;
    }

    const httpPartType = getHttpPartType(ctx.program, type);
    if (httpPartType) {
      addModelName(ctx, httpPartType, names, seen);
      return;
    }
    if (isHttpFileModel(ctx.program, type)) return;

    if (!type.name || isTypeSpecNamespaceModel(type)) {
      for (const prop of walkPropertiesInherited(type)) {
        addModelName(ctx, prop.type, names, seen);
      }
      const additionalType = getAdditionalPropertiesValue(type);
      if (additionalType) addModelName(ctx, additionalType, names, seen);
      return;
    }

    const mapper = type.templateMapper;
    if (mapper) {
      for (const arg of mapper.args) {
        if (isType(arg)) {
          addModelName(ctx, arg, names, seen);
        }
      }
    }

    names.add(getGeneratedTypeName(ctx, type, "Model"));

    for (const prop of walkPropertiesInherited(type)) {
      addModelName(ctx, prop.type, names, seen);
    }
    const additionalType = getAdditionalPropertiesValue(type);
    if (additionalType) addModelName(ctx, additionalType, names, seen);
  }

  if (type.kind === "Union") {
    addReferencedUnionName(ctx, type, names, seen);
    for (const v of type.variants.values()) {
      addModelName(ctx, v.type, names, seen);
    }
  }

  if (type.kind === "Scalar") {
    addReferencedScalarName(ctx, type, names, seen);
  }

  if (type.kind === "Enum" && hasGeneratedTypeNameCollision(ctx, type)) {
    names.add(getGeneratedTypeName(ctx, type, "Enum"));
  }

  if (type.kind === "Tuple") {
    for (const value of type.values) {
      addModelName(ctx, value, names, seen);
    }
  }

  if (type.kind === "ModelProperty" || type.kind === "UnionVariant") {
    addModelName(ctx, type.type, names, seen);
  }
}

function addReferencedUnionName(
  ctx: EmitterCtx,
  type: Extract<Type, { kind: "Union" }>,
  names: Set<string>,
  seen: Set<Type>,
): void {
  if (!isNamedUnionReference(type) && !hasGeneratedTypeNameCollision(ctx, type)) return;
  names.add(getGeneratedTypeName(ctx, type, "Union"));
  addTemplateArgumentModelNames(ctx, type.templateMapper?.args ?? [], names, seen);
}

function addReferencedScalarName(
  ctx: EmitterCtx,
  type: Extract<Type, { kind: "Scalar" }>,
  names: Set<string>,
  seen: Set<Type>,
): void {
  if (!isTemplatedScalarReference(type) && !hasGeneratedTypeNameCollision(ctx, type)) return;
  names.add(getGeneratedTypeName(ctx, type, "Scalar"));
  addTemplateArgumentModelNames(ctx, type.templateMapper?.args ?? [], names, seen);
}

function addTemplateArgumentModelNames(
  ctx: EmitterCtx,
  args: readonly unknown[],
  names: Set<string>,
  seen: Set<Type>,
): void {
  for (const arg of args) {
    if (isEntityLike(arg) && isType(arg)) {
      addModelName(ctx, arg, names, seen);
    }
  }
}

export function groupOperations(ctx: EmitterCtx, operations: HttpOperation[]): OperationGroup[] {
  const standalone: HttpOperation[] = [];
  const grouped = new Map<Interface, HttpOperation[]>();

  for (const op of operations) {
    const iface = op.operation.interface;
    if (!iface) {
      standalone.push(op);
      continue;
    }

    const interfaceOperations = grouped.get(iface) ?? [];
    interfaceOperations.push(op);
    grouped.set(iface, interfaceOperations);
  }

  const interfaceCandidates = [...grouped.keys()].map((iface) => {
    const relativeNamespace = getRelativeNamespaceSegments(ctx.service.namespace, iface.namespace);
    const qualifiedSegments =
      relativeNamespace.length > 0 ? [...relativeNamespace, iface.name] : [iface.name, "Interface"];
    return {
      value: iface,
      stableKey: `${getNamespaceFullName(iface.namespace)}.${iface.name}`,
      baseName: iface.name,
      qualifiedName: qualifiedSegments.join("_"),
      fallbackName: [ctx.serviceName, ...qualifiedSegments, "Interface"].join("_"),
    };
  });
  const standaloneExportName = tsIdentifier(ctx.serviceName, "Group");
  const interfaceExportNames = allocateGeneratedNames(
    interfaceCandidates,
    new Set([
      tsIdentifier(ctx.serviceName, "Service"),
      ...(standalone.length > 0 ? [standaloneExportName] : []),
    ]),
  );
  const interfacePropertyNames = allocateGeneratedNames(
    interfaceCandidates.map((candidate) => ({ ...candidate, preserveBaseName: true })),
  );

  const ordered: OperationGroup[] = [...grouped.entries()].map(([iface, interfaceOperations]) => ({
    interfaceName: iface.name,
    propertyName: interfacePropertyNames.get(iface)!,
    exportName: interfaceExportNames.get(iface)!,
    operations: interfaceOperations,
  }));
  if (standalone.length > 0) {
    ordered.push({
      propertyName: "__standalone__",
      exportName: standaloneExportName,
      operations: standalone,
    });
  }

  return ordered;
}
