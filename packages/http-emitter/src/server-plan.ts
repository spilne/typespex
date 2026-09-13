import type { HttpOperation } from "@typespec/http";
import {
  allocateGeneratedNames,
  collectReferencedTypes,
  getNamespaceFullName,
  getRelativeNamespaceSegments,
  type EmitterCtx,
  type GeneratedFileNames,
} from "./ctx.js";
import { buildInputType } from "./server-input-types.js";
import { collectModelImports, groupOperations } from "./server-operation-layout.js";
import { buildResultType } from "./server-response-plan.js";
import { getPayloadTypeAliasDeclarations } from "./payload-context.js";
import { getJsonWireSerializerDeclarations } from "./json-wire-transforms.js";
import {
  emitHintEntries,
  emitOperationHintEntries,
  getOperationNamespaces,
  type EmittedHintEntry,
} from "./emit-server-hints.js";
import { getRouteSelections, type RouteSelectionEmission } from "./route-selection.js";
import { lowerUriTemplate, type RoutePattern } from "./uri-template.js";
import {
  buildInputDecoderPlan,
  getServerInputDecoderImports,
  type InputDecoderPlan,
} from "./server-input-decoders.js";
import { buildResponseEncoder } from "./server-response-encoder.js";
import { getXmlCodecDeclarations } from "./xml-wire-codecs.js";

export interface ServerPlan {
  readonly serviceName: string;
  readonly fileNames: GeneratedFileNames;
  readonly modelImports: readonly string[];
  readonly handlerModelImports: readonly string[];
  readonly inputDecoderImports: readonly string[];
  /**
   * Complete snapshot for the handler signatures below. Building the groups
   * materializes every input and result type before this snapshot is captured.
   */
  readonly payloadTypeAliases: readonly string[];
  readonly jsonSerializerDeclarations: readonly string[];
  readonly xmlCodecDeclarations: readonly string[];
  readonly groups: readonly ServerGroupPlan[];
}

export interface ServerGroupPlan {
  readonly interfaceName?: string;
  readonly propertyName: string;
  readonly exportName: string;
  readonly operations: readonly ServerOperationPlan[];
}

export interface ServerOperationPlan {
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
  readonly namespaces: readonly ServerNamespacePlan[];
  readonly operationHints: readonly EmittedHintEntry[];
  readonly inputDecoder: InputDecoderPlan;
  readonly responseEncoder: string;
}

export interface ServerNamespacePlan {
  readonly name: string;
  readonly fullName: string;
  readonly hints: readonly EmittedHintEntry[];
}

export function buildServerPlan(ctx: EmitterCtx, httpOperations: HttpOperation[]): ServerPlan {
  const operationIds = allocateOperationIds(ctx, httpOperations);
  const routeSelections = getRouteSelections(ctx, httpOperations);
  const rawGroups = groupOperations(ctx, httpOperations);
  const interfaceProperties = new Set(
    rawGroups
      .filter((group) => group.interfaceName !== undefined)
      .map((group) => group.propertyName),
  );
  const modelImports = collectModelImports(ctx, httpOperations);
  const plannedContracts = collectReferencedTypes(ctx, () =>
    rawGroups.map((group) => {
      const operationNames = allocateOperationNames(
        ctx,
        group.operations,
        group.interfaceName ? new Set() : interfaceProperties,
      );
      return {
        interfaceName: group.interfaceName,
        propertyName: group.propertyName,
        exportName: group.exportName,
        operations: group.operations.map((operation) => ({
          source: operation,
          contract: buildOperationContract(
            ctx,
            operation,
            operationNames.get(operation)!,
            operationIds.get(operation)!,
            routeSelections.get(operation),
          ),
        })),
      };
    }),
  );

  const responseEncoders = new Map<HttpOperation, string>();
  for (const group of plannedContracts.value) {
    for (const operation of group.operations) {
      responseEncoders.set(
        operation.source,
        buildResponseEncoder(ctx, operation.source, operation.contract.resultType),
      );
    }
  }

  const inputDecoders = new Map<HttpOperation, InputDecoderPlan>();
  for (const group of plannedContracts.value) {
    const inputsName = `${group.exportName}Input`;
    for (const operation of group.operations) {
      inputDecoders.set(
        operation.source,
        buildInputDecoderPlan(
          ctx,
          operation.source,
          operation.contract.inputType,
          inputsName,
          operation.contract.propertyName,
        ),
      );
    }
  }

  const groups: ServerGroupPlan[] = plannedContracts.value.map((group) => ({
    interfaceName: group.interfaceName,
    propertyName: group.propertyName,
    exportName: group.exportName,
    operations: group.operations.map(({ source, contract }) => ({
      ...contract,
      inputDecoder: inputDecoders.get(source)!,
      responseEncoder: responseEncoders.get(source)!,
    })),
  }));

  // Complete codec graphs before taking immutable renderer snapshots. XML
  // codecs can register JSON serializers, and both can finish payload aliases.
  const xmlCodecDeclarations = getXmlCodecDeclarations(ctx);
  const jsonSerializerDeclarations = getJsonWireSerializerDeclarations(ctx);
  const payloadTypeAliases = getPayloadTypeAliasDeclarations(ctx);
  const availableModelImports = new Set(modelImports);

  return {
    serviceName: ctx.serviceName,
    fileNames: ctx.fileNames,
    modelImports,
    handlerModelImports: plannedContracts.names.filter((name) => availableModelImports.has(name)),
    inputDecoderImports: getServerInputDecoderImports(ctx, httpOperations),
    payloadTypeAliases,
    jsonSerializerDeclarations,
    xmlCodecDeclarations,
    groups,
  };
}

type ServerOperationContract = Omit<ServerOperationPlan, "inputDecoder" | "responseEncoder">;

function buildOperationContract(
  ctx: EmitterCtx,
  operation: HttpOperation,
  propertyName: string,
  operationId: string,
  routeSelection: RouteSelectionEmission | undefined,
): ServerOperationContract {
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
