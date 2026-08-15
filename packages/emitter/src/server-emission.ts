import type { HttpOperation } from "@typespec/http";
import {
  allocateGeneratedNames,
  getNamespaceFullName,
  getRelativeNamespaceSegments,
  type EmitterCtx,
} from "./ctx.js";
import {
  buildInputType,
  buildResultType,
  collectModelImports,
  groupOperations,
} from "./emit-server-common.js";
import { getPayloadTypeAliasDeclarations } from "./payload-context.js";
import {
  emitHintEntries,
  emitOperationHintEntries,
  getOperationNamespaces,
  type EmittedHintEntry,
} from "./emit-server-hints.js";
import { getRouteSelections, type RouteSelectionEmission } from "./route-selection.js";
import { lowerUriTemplate, type RoutePattern } from "./uri-template.js";

export interface ServerEmission {
  readonly serviceName: string;
  readonly modelImports: readonly string[];
  readonly payloadTypeAliases: readonly string[];
  readonly groups: readonly ServerEmissionGroup[];
}

export interface ServerEmissionGroup {
  readonly interfaceName?: string;
  readonly propertyName: string;
  readonly exportName: string;
  readonly operations: readonly ServerOperationEmission[];
}

export interface ServerOperationEmission {
  readonly name: string;
  readonly propertyName: string;
  readonly operationId: string;
  readonly inputType: string;
  readonly resultType: string;
  readonly method: string;
  readonly path: string;
  readonly routePatterns: readonly RoutePattern[];
  readonly routeSelection?: RouteSelectionEmission;
  readonly serviceHints: readonly EmittedHintEntry[];
  readonly namespaces: readonly ServerNamespaceEmission[];
  readonly operationHints: readonly EmittedHintEntry[];
  readonly httpOperation: HttpOperation;
}

export interface ServerNamespaceEmission {
  readonly name: string;
  readonly fullName: string;
  readonly hints: readonly EmittedHintEntry[];
}

export function buildServerEmission(
  ctx: EmitterCtx,
  httpOperations: HttpOperation[],
): ServerEmission {
  const operationIds = allocateOperationIds(ctx, httpOperations);
  const routeSelections = getRouteSelections(ctx, httpOperations);
  const rawGroups = groupOperations(ctx, httpOperations);
  const interfaceProperties = new Set(
    rawGroups
      .filter((group) => group.interfaceName !== undefined)
      .map((group) => group.propertyName),
  );
  const groups = rawGroups.map((group) => {
    const operationNames = allocateOperationNames(
      ctx,
      group.operations,
      group.interfaceName ? new Set() : interfaceProperties,
    );
    return {
      interfaceName: group.interfaceName,
      propertyName: group.propertyName,
      exportName: group.exportName,
      operations: group.operations.map((operation) =>
        buildOperationEmission(
          ctx,
          operation,
          operationNames.get(operation)!,
          operationIds.get(operation)!,
          routeSelections.get(operation),
        ),
      ),
    };
  });

  return {
    serviceName: ctx.serviceName,
    modelImports: collectModelImports(ctx, httpOperations),
    payloadTypeAliases: getPayloadTypeAliasDeclarations(ctx),
    groups,
  };
}

function buildOperationEmission(
  ctx: EmitterCtx,
  operation: HttpOperation,
  propertyName: string,
  operationId: string,
  routeSelection: RouteSelectionEmission | undefined,
): ServerOperationEmission {
  const operationName = operation.operation.name;
  const lowered = lowerUriTemplate(operation);
  if (!lowered.ok) {
    throw new Error(
      `URI template preflight did not reject ${JSON.stringify(operation.uriTemplate)}: ${lowered.reason}`,
    );
  }
  return {
    name: operationName,
    propertyName,
    operationId,
    inputType: buildInputType(ctx, operation),
    resultType: buildResultType(ctx, operation),
    method: operation.verb.toUpperCase(),
    path: lowered.value.path,
    routePatterns: lowered.value.routePatterns,
    routeSelection,
    serviceHints: emitHintEntries(ctx, ctx.service.namespace),
    namespaces: getOperationNamespaces(ctx.service.namespace, operation.operation.namespace).map(
      (namespace) => ({
        name: namespace.name,
        fullName: getNamespaceFullName(namespace),
        hints: emitHintEntries(ctx, namespace),
      }),
    ),
    operationHints: emitOperationHintEntries(ctx, operation),
    httpOperation: operation,
  };
}

function allocateOperationNames(
  ctx: EmitterCtx,
  operations: readonly HttpOperation[],
  reservedNames: ReadonlySet<string>,
): Map<HttpOperation, string> {
  return allocateGeneratedNames(
    operations.map((operation) => {
      const namespace = getRelativeNamespaceSegments(
        ctx.service.namespace,
        operation.operation.namespace,
      );
      const interfaceName = operation.operation.interface?.name;
      const qualifiedSegments = interfaceName
        ? [...namespace, interfaceName, operation.operation.name]
        : [...namespace, operation.operation.name];
      return {
        value: operation,
        stableKey: operationStableKey(operation),
        baseName: operation.operation.name,
        qualifiedName: qualifiedSegments.join("_"),
        fallbackName: [ctx.serviceName, ...qualifiedSegments, "Operation"].join("_"),
        preserveBaseName: true,
      };
    }),
    reservedNames,
  );
}

function allocateOperationIds(
  ctx: EmitterCtx,
  operations: readonly HttpOperation[],
): Map<HttpOperation, string> {
  const legacyIds = new Map<HttpOperation, string>();
  const counts = new Map<string, number>();
  for (const operation of operations) {
    const operationName = operation.operation.name;
    const id = operation.operation.interface
      ? `${operation.operation.interface.name}.${operationName}`
      : `${ctx.serviceName}.${operationName}`;
    legacyIds.set(operation, id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const allocated = new Map<HttpOperation, string>();
  const used = new Set<string>();
  const ordered = [...operations].sort((a, b) =>
    operationStableKey(a).localeCompare(operationStableKey(b)),
  );
  for (const operation of ordered) {
    const legacyId = legacyIds.get(operation)!;
    if (counts.get(legacyId) === 1 && !used.has(legacyId)) {
      allocated.set(operation, legacyId);
      used.add(legacyId);
    }
  }

  for (const operation of ordered) {
    if (allocated.has(operation)) continue;
    const qualifiedId = operationQualifiedName(operation);
    let id = qualifiedId;
    let suffix = 2;
    while (used.has(id)) {
      id = `${qualifiedId}.${suffix}`;
      suffix += 1;
    }
    allocated.set(operation, id);
    used.add(id);
  }

  return allocated;
}

function operationQualifiedName(operation: HttpOperation): string {
  return [
    getNamespaceFullName(operation.operation.namespace),
    operation.operation.interface?.name,
    operation.operation.name,
  ]
    .filter((part): part is string => Boolean(part))
    .join(".");
}

function operationStableKey(operation: HttpOperation): string {
  return `${operationQualifiedName(operation)}:${operation.verb}:${operation.uriTemplate}`;
}

export function collectReferencedModelImports(emission: ServerEmission): string[] {
  const available = new Set(emission.modelImports);
  const imported = new Set<string>();

  for (const alias of emission.payloadTypeAliases) {
    collectFromText(alias);
  }
  for (const group of emission.groups) {
    for (const operation of group.operations) {
      collectFromText(operation.inputType);
      collectFromText(operation.resultType);
    }
  }

  return [...imported].sort();

  function collectFromText(text: string): void {
    for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      const name = match[0];
      if (available.has(name)) imported.add(name);
    }
  }
}
