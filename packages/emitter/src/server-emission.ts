import type { HttpOperation, HttpService } from "@typespec/http";
import type { EmitterCtx } from "./ctx.js";
import {
  buildInputType,
  buildResultType,
  collectModelImports,
  groupOperations,
  toColonPath,
} from "./emit-server-common.js";
import {
  emitHintEntries,
  getNamespaceFullName,
  getOperationNamespaces,
  type EmittedHintEntry,
} from "./emit-server-hints.js";

export interface ServerEmission {
  readonly serviceName: string;
  readonly modelImports: readonly string[];
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
  readonly operationId: string;
  readonly inputType: string;
  readonly resultType: string;
  readonly method: string;
  readonly path: string;
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
  const groups = groupOperations(httpOperations).map((group) => ({
    interfaceName: group.interfaceName,
    propertyName: group.propertyName,
    exportName: group.interfaceName ?? ctx.serviceName,
    operations: group.operations.map((operation) => buildOperationEmission(ctx, operation, group.interfaceName)),
  }));

  return {
    serviceName: ctx.serviceName,
    modelImports: collectModelImports(ctx, httpOperations),
    groups,
  };
}

function buildOperationEmission(
  ctx: EmitterCtx,
  operation: HttpOperation,
  interfaceName: string | undefined,
): ServerOperationEmission {
  const operationName = operation.operation.name;
  return {
    name: operationName,
    operationId: interfaceName
      ? `${interfaceName}.${operationName}`
      : `${ctx.serviceName}.${operationName}`,
    inputType: buildInputType(ctx, operation),
    resultType: buildResultType(ctx, operation),
    method: operation.verb.toUpperCase(),
    path: toColonPath(operation.path),
    serviceHints: emitHintEntries(ctx, ctx.service.namespace),
    namespaces: getOperationNamespaces(ctx.service.namespace, operation.operation.namespace).map((namespace) => ({
      name: namespace.name,
      fullName: getNamespaceFullName(namespace),
      hints: emitHintEntries(ctx, namespace),
    })),
    operationHints: emitHintEntries(ctx, operation.operation),
    httpOperation: operation,
  };
}

export function collectReferencedModelImports(
  emission: ServerEmission,
): string[] {
  const available = new Set(emission.modelImports);
  const imported = new Set<string>();

  for (const group of emission.groups) {
    for (const operation of group.operations) {
      for (const text of [operation.inputType, operation.resultType]) {
        for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
          const name = match[0];
          if (available.has(name)) {
            imported.add(name);
          }
        }
      }
    }
  }

  return [...imported].sort();
}
