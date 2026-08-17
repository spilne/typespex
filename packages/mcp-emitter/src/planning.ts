import {
  EmptyVisibilityProvider,
  getNamespaceFullName,
  getParameterVisibilityFilter,
  getReturnTypeVisibilityFilter,
  getService,
  isErrorModel,
  isVisible,
  type EmitContext,
  type Namespace,
  type Operation,
  type Type,
} from "@typespec/compiler";
import type { HttpOperation } from "@typespec/http";
import {
  COMPILER_PLAN_VERSION,
  createServiceLayout,
  isVoidType,
  kebabCase,
  pascalCase,
  TypePlanner,
  typescriptIdentifier,
  type OperationPlan,
  type ServicePlan,
} from "@typespex/compiler-core/unstable";
import type { McpServerMetadata, McpToolMetadata } from "@typespex/mcp";
import { analyzeBridgeStreams, createHttpWireOperationPlan } from "./http-planner.js";
import { $lib, type McpEmitterOptions, type McpMode } from "./lib.js";
import { schemasDefinitelyDisjoint } from "./schema-analysis.js";
import type { BridgePlanningContext, PlannedServer, PlannedTool, ResolvedModes } from "./types.js";

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const UNSAFE_TOOL_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export async function loadBridgePlanningContext(
  context: EmitContext<McpEmitterOptions>,
): Promise<BridgePlanningContext | undefined> {
  let modules: readonly [
    typeof import("@typespec/http"),
    typeof import("@typespec/http/experimental"),
  ];
  try {
    modules = await Promise.all([import("@typespec/http"), import("@typespec/http/experimental")]);
  } catch {
    $lib.reportDiagnostic(context.program, {
      code: "bridge-http-library-missing",
      target: context.program.getGlobalNamespaceType(),
    });
    return undefined;
  }
  const [http, experimental] = modules;
  const [services, diagnostics] = http.getAllHttpServices(context.program);
  for (const diagnostic of diagnostics) context.program.reportDiagnostic(diagnostic);
  return {
    services: new Map(services.map((service) => [service.namespace, service])),
    api: {
      getServers: http.getServers,
      getStreamMetadata: experimental.getStreamMetadata,
      HttpVisibilityProvider: http.HttpVisibilityProvider,
    },
  };
}

export function planServer(
  context: EmitContext<McpEmitterOptions>,
  metadata: McpServerMetadata,
  tools: readonly McpToolMetadata[],
  modes: ResolvedModes,
  bridge: BridgePlanningContext | undefined,
  nativeStreamTypes: ReadonlySet<import("@typespec/compiler").Model> | undefined,
): PlannedServer {
  const serviceMetadata = getService(context.program, metadata.namespace);
  const name = metadata.name || serviceMetadata?.title || metadata.namespace.name || "McpServer";
  const symbolName = typescriptIdentifier(pascalCase(name), "McpServer");
  if (tools.length === 0) {
    $lib.reportDiagnostic(context.program, { code: "no-tools", target: metadata.namespace });
  }

  const seenToolNames = new Map<string, McpToolMetadata>();
  const roots: Type[] = [];
  for (const tool of tools) {
    const toolName = tool.name || tool.operation.name;
    if (!TOOL_NAME.test(toolName) || UNSAFE_TOOL_NAMES.has(toolName)) {
      $lib.reportDiagnostic(context.program, {
        code: "invalid-tool-name",
        format: { name: toolName },
        target: tool.operation,
      });
    }
    const previous = seenToolNames.get(toolName);
    if (previous) {
      $lib.reportDiagnostic(context.program, {
        code: "duplicate-tool-name",
        format: {
          first: operationDisplayName(previous.operation),
          second: operationDisplayName(tool.operation),
          name: toolName,
        },
        target: tool.operation,
      });
    } else {
      seenToolNames.set(toolName, tool);
    }
    roots.push(tool.operation.parameters, tool.operation.returnType);
  }

  const httpService = bridge?.services.get(metadata.namespace);
  const httpOperations = new Map<Operation, HttpOperation>();
  if (bridge) {
    if (!getService(context.program, metadata.namespace)) {
      $lib.reportDiagnostic(context.program, {
        code: "bridge-requires-service",
        target: metadata.namespace,
      });
    }
    for (const tool of tools) {
      const operation = httpService?.operations.find(
        (candidate) => candidate.operation === tool.operation,
      );
      if (!operation) {
        $lib.reportDiagnostic(context.program, {
          code: "bridge-operation-missing",
          format: { name: tool.name || tool.operation.name },
          target: tool.operation,
        });
      } else {
        httpOperations.set(tool.operation, operation);
      }
    }
  }
  const streamAnalysis = bridge
    ? analyzeBridgeStreams(context.program, [...httpOperations.values()], bridge.api)
    : undefined;
  for (const issue of streamAnalysis?.issues ?? []) {
    $lib.reportDiagnostic(context.program, {
      code: "bridge-unsupported",
      format: { name: issue.operation.operation.name, message: issue.message },
      target: issue.operation.operation,
    });
  }

  const planner = new TypePlanner(context.program, {
    datetimeMode: context.options["datetime-mode"],
    canonicalJsonWire: modes.httpBridge,
    ...(streamAnalysis ? { streamElementTypes: streamAnalysis.elementTypes } : {}),
    ...(nativeStreamTypes
      ? {
          nativeStreamTypes: new Set(
            [...nativeStreamTypes].filter((stream) => !streamAnalysis?.elementTypes.has(stream)),
          ),
        }
      : {}),
    ...(streamAnalysis ? { typeSubstitutions: streamAnalysis.typeSubstitutions } : {}),
    onIssue(issue) {
      $lib.reportDiagnostic(context.program, {
        code: "compiler-error",
        format: { message: issue.message },
        target: issue.target,
      });
    },
  });
  planner.prepare(roots);

  const usedSymbols = new Set<string>();
  const plannedTools = tools.map((tool): PlannedTool => {
    const toolName = tool.name || tool.operation.name;
    const baseSymbol = typescriptIdentifier(pascalCase(toolName), "Tool");
    let toolSymbol = baseSymbol;
    let suffix = 2;
    while (usedSymbols.has(toolSymbol)) toolSymbol = `${baseSymbol}${suffix++}`;
    usedSymbols.add(toolSymbol);
    const { success, errors, allowsVoid } = partitionReturnType(context, tool.operation.returnType);
    const httpOperation = httpOperations.get(tool.operation);
    const http =
      httpOperation && bridge && httpService
        ? createHttpWireOperationPlan(
            context.program,
            httpOperation,
            toolName,
            httpService.namespace,
            bridge.api,
            httpService.authentication,
          )
        : undefined;
    const visibilityProvider =
      httpOperation && bridge
        ? bridge.api.HttpVisibilityProvider(httpOperation.verb)
        : EmptyVisibilityProvider;
    const parameterVisibility = getParameterVisibilityFilter(
      context.program,
      tool.operation,
      visibilityProvider,
    );
    const returnVisibility = getReturnTypeVisibilityFilter(
      context.program,
      tool.operation,
      visibilityProvider,
    );
    const inputProjection = {
      key: `${toolSymbol}Input`,
      propertyFilter: (property: import("@typespec/compiler").ModelProperty) =>
        isVisible(context.program, property, parameterVisibility),
    };
    const outputProjection = {
      key: `${toolSymbol}Output`,
      propertyFilter: (property: import("@typespec/compiler").ModelProperty) =>
        isVisible(context.program, property, returnVisibility),
    };
    const successPlan =
      success.length > 0
        ? planner.createWirePlan(success, { projection: outputProjection })
        : undefined;
    const errorPlan =
      errors.length > 0
        ? planner.createWirePlan(errors, { projection: outputProjection })
        : undefined;
    const requiresTaggedResult = Boolean(
      successPlan && errorPlan && !schemasDefinitelyDisjoint(successPlan, errorPlan),
    );
    if (requiresTaggedResult) {
      $lib.reportDiagnostic(context.program, {
        code: "ambiguous-tool-result",
        format: { name: toolName },
        target: tool.operation,
      });
    }
    const inputPlan = planner.createWirePlan(tool.operation.parameters, {
      projection: inputProjection,
    });
    const operationPlan: OperationPlan = {
      version: COMPILER_PLAN_VERSION,
      name: toolName,
      input: inputPlan,
      ...(successPlan ? { success: successPlan } : {}),
      ...(errorPlan ? { errors: errorPlan } : {}),
    };
    return {
      plan: operationPlan,
      metadata: tool,
      operation: tool.operation,
      name: toolName,
      symbolName: toolSymbol,
      allowsVoid,
      annotations: mergeToolAnnotations(tool.annotations, httpOperation?.verb),
      ...(http ? { http } : {}),
      requiresTaggedResult,
    };
  });

  const { outputDir, fileNames } = createServiceLayout(
    metadata.namespace.name || name,
    {
      models: "models",
      operations: "mcp-operations",
      server: "mcp-server",
      httpBridge: "mcp-http-bridge",
      stdio: "mcp-stdio",
      node: "mcp-node",
      bun: "mcp-bun",
      express: "mcp-express",
      hono: "mcp-hono",
    },
    context.options,
  );
  const servicePlan: ServicePlan = {
    version: COMPILER_PLAN_VERSION,
    name,
    namespace: getNamespaceFullName(metadata.namespace),
    types: planner.createTypePlans(),
    operations: plannedTools.map((tool) => tool.plan),
  };
  return {
    plan: servicePlan,
    metadata,
    name,
    symbolName,
    outputDir,
    fileNames,
    planner,
    tools: plannedTools,
    applicationModule: context.options["application-module"]?.replaceAll(
      "{service}",
      kebabCase(metadata.namespace.name || name),
    ),
    modes,
  };
}

export async function discoverNativeStreamTypes(
  context: EmitContext<McpEmitterOptions>,
  operations: readonly Operation[],
): Promise<ReadonlySet<import("@typespec/compiler").Model> | undefined> {
  let isStream:
    | ((program: typeof context.program, model: import("@typespec/compiler").Model) => boolean)
    | undefined;
  try {
    ({ isStream } = await import("@typespec/streams"));
  } catch {
    return undefined;
  }
  const streams = new Set<import("@typespec/compiler").Model>();
  const visited = new Set<Type>();
  const visit = (type: Type): void => {
    if (visited.has(type)) return;
    visited.add(type);
    switch (type.kind) {
      case "Model":
        if (isStream!(context.program, type)) streams.add(type);
        if (type.baseModel) visit(type.baseModel);
        for (const property of type.properties.values()) visit(property.type);
        if (type.indexer?.value) visit(type.indexer.value);
        break;
      case "Union":
        for (const variant of type.variants.values()) visit(variant.type);
        break;
      case "UnionVariant":
      case "ModelProperty":
        visit(type.type);
        break;
      case "Tuple":
        for (const value of type.values) visit(value);
        break;
    }
  };
  for (const operation of operations) {
    visit(operation.parameters);
    visit(operation.returnType);
  }
  return streams;
}

function partitionReturnType(
  context: EmitContext<McpEmitterOptions>,
  returnType: Type,
): { success: Type[]; errors: Type[]; allowsVoid: boolean } {
  const success: Type[] = [];
  const errors: Type[] = [];
  let allowsVoid = false;
  const seen = new Set<Type>();
  const visit = (type: Type): void => {
    if (seen.has(type)) return;
    seen.add(type);
    if (isVoidType(type)) {
      allowsVoid = true;
      return;
    }
    if (type.kind === "Union") {
      for (const variant of type.variants.values()) visit(variant.type);
      return;
    }
    if (type.kind === "UnionVariant" || type.kind === "ModelProperty") {
      visit(type.type);
      return;
    }
    if (type.kind === "Model" && isErrorModel(context.program, type)) errors.push(type);
    else success.push(type);
  };
  visit(returnType);
  return { success, errors, allowsVoid };
}

export function resolveModes(option: McpEmitterOptions["mode"]): ResolvedModes {
  const values: readonly McpMode[] = option ?? ["native"];
  return {
    native: values.includes("native"),
    httpBridge: values.includes("http-bridge"),
  };
}

function mergeToolAnnotations(
  explicit: McpToolMetadata["annotations"],
  verb: HttpOperation["verb"] | undefined,
): McpToolMetadata["annotations"] {
  if (!verb) return explicit;
  const inferred =
    verb === "get" || verb === "head"
      ? {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        }
      : verb === "put" || verb === "delete"
        ? {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: true,
          }
        : {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
          };
  return { ...inferred, ...explicit };
}

export function operationIsWithin(operation: Operation, namespace: Namespace): boolean {
  let current = operation.interface?.namespace ?? operation.namespace;
  while (current) {
    if (current === namespace) return true;
    current = current.namespace;
  }
  return false;
}

function operationDisplayName(operation: Operation): string {
  const namespace = operation.interface?.namespace ?? operation.namespace;
  const prefix = namespace ? getNamespaceFullName(namespace) : "";
  return `${prefix ? `${prefix}.` : ""}${operation.interface ? `${operation.interface.name}.` : ""}${operation.name}`;
}
