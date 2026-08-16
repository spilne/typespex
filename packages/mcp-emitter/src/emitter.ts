import {
  EmptyVisibilityProvider,
  emitFile,
  getDoc,
  getNamespaceFullName,
  getParameterVisibilityFilter,
  getReturnTypeVisibilityFilter,
  getService,
  getSummary,
  isErrorModel,
  isVisible,
  resolvePath,
  type EmitContext,
  type Namespace,
  type Operation,
  type Type,
} from "@typespec/compiler";
import type { HttpOperation, HttpService } from "@typespec/http";
import {
  ArtifactFormatError,
  COMPILER_PLAN_VERSION,
  assertUniqueArtifactPaths,
  camelCase,
  createServiceLayout,
  formatTypeScriptArtifacts,
  isVoidType,
  kebabCase,
  pascalCase,
  TypePlanner,
  typescriptIdentifier,
  typescriptString,
  type ArtifactPlan,
  type JsonWirePlan,
  type OperationPlan,
  type ServicePlan,
} from "@typespex/compiler-core/unstable";
import type { HttpWireOperationPlan } from "@typespex/http-client";
import { listMcpServers, listMcpTools } from "@typespex/mcp";
import {
  analyzeBridgeStreams,
  createHttpWireOperationPlan,
  type HttpPlanningApi,
} from "./http-planner.js";
import { $lib, type McpEmitterOptions, type McpLauncher, type McpMode } from "./lib.js";
import type { McpServerMetadata, McpToolMetadata } from "@typespex/mcp";

const DEFAULT_LAUNCHERS: readonly McpLauncher[] = [];
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const UNSAFE_TOOL_NAMES = new Set(["__proto__", "constructor", "prototype"]);

interface ResolvedModes {
  readonly native: boolean;
  readonly httpBridge: boolean;
}

interface PlannedServer {
  readonly plan: ServicePlan;
  readonly metadata: McpServerMetadata;
  readonly name: string;
  readonly symbolName: string;
  readonly outputDir: string;
  readonly fileNames: GeneratedFileNames;
  readonly planner: TypePlanner;
  readonly tools: readonly PlannedTool[];
  readonly applicationModule?: string;
  readonly modes: ResolvedModes;
}

interface PlannedTool {
  readonly plan: OperationPlan;
  readonly metadata: McpToolMetadata;
  readonly operation: Operation;
  readonly name: string;
  readonly symbolName: string;
  readonly allowsVoid: boolean;
  readonly annotations?: McpToolMetadata["annotations"];
  readonly http?: HttpWireOperationPlan;
  readonly requiresTaggedResult: boolean;
}

interface BridgePlanningContext {
  readonly services: ReadonlyMap<Namespace, HttpService>;
  readonly api: HttpPlanningApi;
}

interface GeneratedFileNames {
  readonly models: string;
  readonly operations: string;
  readonly server: string;
  readonly httpClient: string;
  readonly stdio: string;
  readonly node: string;
  readonly bun: string;
  readonly express: string;
  readonly hono: string;
}

export async function $onEmit(context: EmitContext<McpEmitterOptions>): Promise<void> {
  const servers = listMcpServers(context.program);
  const tools = listMcpTools(context.program);
  if (servers.length === 0) {
    $lib.reportDiagnostic(context.program, {
      code: "no-mcp-servers",
      target: context.program.getGlobalNamespaceType(),
    });
    return;
  }

  const launchers = context.options.launchers ?? DEFAULT_LAUNCHERS;
  const modes = resolveModes(context.options.mode);
  const applicationModule = context.options["application-module"];
  if (launchers.length > 0 && !applicationModule) {
    $lib.reportDiagnostic(context.program, {
      code: "missing-application-module",
      target: context.program.getGlobalNamespaceType(),
    });
  }
  if (servers.length > 1 && applicationModule && !applicationModule.includes("{service}")) {
    $lib.reportDiagnostic(context.program, {
      code: "application-module-needs-service-token",
      target: context.program.getGlobalNamespaceType(),
    });
  }

  const ownerByTool = new Map<McpToolMetadata, McpServerMetadata>();
  for (const tool of tools) {
    const owners = servers.filter((server) => operationIsWithin(tool.operation, server.namespace));
    const owner = owners.sort(
      (left, right) =>
        getNamespaceFullName(right.namespace).length - getNamespaceFullName(left.namespace).length,
    )[0];
    if (!owner) {
      $lib.reportDiagnostic(context.program, {
        code: "tool-outside-server",
        target: tool.operation,
      });
    } else {
      ownerByTool.set(tool, owner);
    }
  }

  const bridge = modes.httpBridge ? await loadBridgePlanningContext(context) : undefined;
  const nativeStreamTypes = modes.native
    ? await discoverNativeStreamTypes(
        context,
        tools.map((tool) => tool.operation),
      )
    : undefined;
  const planned = servers.map((server) =>
    planServer(
      context,
      server,
      tools.filter((tool) => ownerByTool.get(tool) === server),
      modes,
      bridge,
      nativeStreamTypes,
    ),
  );
  if (context.program.hasError()) return;

  const artifacts = planned.flatMap((server) =>
    emitServerArtifacts(server, launchers, context.options),
  );
  try {
    assertUniqueArtifactPaths(artifacts);
  } catch (error) {
    $lib.reportDiagnostic(context.program, {
      code: "duplicate-output-path",
      format: { message: error instanceof Error ? error.message : String(error) },
      target: context.program.getGlobalNamespaceType(),
    });
    return;
  }

  let formatted: ArtifactPlan[];
  try {
    formatted = await formatTypeScriptArtifacts(artifacts);
  } catch (error) {
    const message =
      error instanceof ArtifactFormatError ? `${error.fileName}: ${error.message}` : String(error);
    $lib.reportDiagnostic(context.program, {
      code: "generated-format-error",
      format: { message },
      target: context.program.getGlobalNamespaceType(),
    });
    return;
  }

  for (const artifact of formatted) {
    await emitFile(context.program, {
      path: resolvePath(context.emitterOutputDir, artifact.outputDir, artifact.fileName),
      content: artifact.content,
    });
  }
}

async function loadBridgePlanningContext(
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

function planServer(
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
      httpClient: "mcp-http-client",
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

async function discoverNativeStreamTypes(
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

function emitServerArtifacts(
  server: PlannedServer,
  launchers: readonly McpLauncher[],
  options: McpEmitterOptions,
): ArtifactPlan[] {
  const artifacts: ArtifactPlan[] = [
    artifact(server, "models", server.fileNames.models, server.planner.emitModels()),
    artifact(server, "mcp-operations", server.fileNames.operations, emitOperations(server)),
    artifact(server, "mcp-server", server.fileNames.server, emitServer(server, launchers)),
  ];

  if (server.modes.httpBridge) {
    artifacts.push(
      artifact(server, "mcp-http-client", server.fileNames.httpClient, emitHttpClient(server)),
    );
  }
  for (const launcher of launchers) {
    artifacts.push(
      artifact(
        server,
        `mcp-${launcher}`,
        server.fileNames[launcher],
        emitLauncher(server, launcher),
      ),
    );
  }
  return artifacts;
}

function emitOperations(server: PlannedServer): string {
  const sharedDefinitions = collectSharedDefinitions(server.tools);
  const definitions = server.tools
    .map((tool) => {
      const input = emitSchemaDefinition(
        `${camelCase(tool.symbolName)}Input`,
        tool.plan.input,
        operationWireAlias(tool.symbolName, "Input", tool.plan.input),
        `${tool.symbolName}Input`,
        sharedDefinitions,
      );
      const success = tool.plan.success
        ? emitSchemaDefinition(
            `${camelCase(tool.symbolName)}Success`,
            tool.plan.success,
            operationWireAlias(tool.symbolName, "Success", tool.plan.success),
            `${tool.symbolName}Success`,
            sharedDefinitions,
          )
        : "";
      const errors = tool.plan.errors
        ? emitSchemaDefinition(
            `${camelCase(tool.symbolName)}Errors`,
            tool.plan.errors,
            operationWireAlias(tool.symbolName, "Error", tool.plan.errors),
            `${tool.symbolName}Error`,
            sharedDefinitions,
          )
        : "";
      return [input, success, errors].filter(Boolean).join("\n");
    })
    .join("\n");

  const tools = server.tools
    .map((tool) => {
      const metadata = tool.metadata;
      const description = getDoc(server.planner.program, tool.operation);
      const title = metadata.title ?? getSummary(server.planner.program, tool.operation);
      return `{
        name: ${typescriptString(tool.name)},
        ${title ? `title: ${typescriptString(title)},` : ""}
        ${description ? `description: ${typescriptString(description)},` : ""}
        ${metadata.icons ? `icons: ${typescriptString(normalizeIcons(metadata.icons))},` : ""}
        ${tool.annotations ? `annotations: ${typescriptString(tool.annotations)},` : ""}
        input: ${camelCase(tool.symbolName)}Input,
        ${tool.plan.success ? `success: ${camelCase(tool.symbolName)}Success,` : ""}
        ${tool.plan.errors ? `errors: ${camelCase(tool.symbolName)}Errors,` : ""}
        ${tool.allowsVoid ? "voidResult: true," : ""}
        ${tool.requiresTaggedResult ? "requiresTaggedResult: true," : ""}
      }`;
    })
    .join(",\n");

  const referencedTypeNames = new Set(
    server.tools.flatMap((tool) =>
      [tool.plan.input, tool.plan.success, tool.plan.errors].flatMap((plan) =>
        plan
          ? [plan.semanticType, plan.wireType].flatMap((expression) =>
              referencedTypeIdentifiers(expression),
            )
          : [],
      ),
    ),
  );
  const modelTypes = [
    ...new Set(server.plan.types.flatMap((type) => [type.semanticType, type.wireType])),
  ].filter((type) => referencedTypeNames.has(type));
  const modelImport =
    modelTypes.length > 0
      ? `import type { ${modelTypes.join(", ")} } from "./${server.fileNames.models}.js";`
      : "";
  const aliases = server.tools
    .map((tool) => {
      const input = tool.plan.input;
      const success = tool.plan.success;
      const errors = tool.plan.errors;
      return `${emitSemanticAndWireAliases(tool.symbolName, "Input", input)}
${success ? emitSemanticAndWireAliases(tool.symbolName, "Success", success) : `export type ${tool.symbolName}Success = never;`}
export type ${tool.symbolName}Output = ${
        [
          ...(success ? [`${tool.symbolName}Success`] : []),
          ...(tool.allowsVoid ? ["void"] : []),
        ].join(" | ") || "never"
      };
${errors ? emitSemanticAndWireAliases(tool.symbolName, "Error", errors) : `export type ${tool.symbolName}Error = never;`}`;
    })
    .join("\n\n");

  return `// Generated by @typespex/mcp-emitter. Do not edit.
import { createSchema, type McpToolDefinition } from "@typespex/mcp-server";
${modelImport}

${aliases}

${sharedDefinitions.declarations.join("\n")}

${definitions}

export const mcpTools = [
${tools}
] as const satisfies readonly McpToolDefinition[];
`;
}

function operationWireAlias(
  symbolName: string,
  kind: "Input" | "Success" | "Error",
  plan: JsonWirePlan,
): string {
  return plan.wireType === plan.semanticType ? `${symbolName}${kind}` : `${symbolName}${kind}Wire`;
}

function emitSemanticAndWireAliases(
  symbolName: string,
  kind: "Input" | "Success" | "Error",
  plan: JsonWirePlan,
): string {
  const semanticName = `${symbolName}${kind}`;
  const wire =
    plan.wireType === plan.semanticType
      ? ""
      : `\nexport type ${symbolName}${kind}Wire = ${plan.wireType};`;
  return `export type ${semanticName} = ${plan.semanticType};${wire}`;
}

function referencedTypeIdentifiers(expression: string): string[] {
  const withoutStrings = expression.replace(/"(?:\\.|[^"\\])*"/g, (value) =>
    " ".repeat(value.length),
  );
  return [...withoutStrings.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)].flatMap((match) => {
    const identifier = match[0];
    const offset = match.index + identifier.length;
    return /^\s*\??\s*:/.test(withoutStrings.slice(offset)) ? [] : [identifier];
  });
}

function emitSchemaDefinition(
  name: string,
  plan: JsonWirePlan,
  wireType: string,
  semanticType: string,
  shared: SharedDefinitions,
): string {
  const typeArguments =
    wireType === semanticType ? `<${semanticType}>` : `<${wireType}, ${semanticType}>`;
  return `const ${name} = createSchema${typeArguments}({
    schema: ${emitSharedDocument(plan.schema, "$defs", shared.schema)},
    ${plan.codec ? `codec: ${emitSharedDocument(plan.codec, "definitions", shared.codec)},` : ""}
  });`;
}

interface SharedDefinitions {
  readonly schema: ReadonlyMap<string, string>;
  readonly codec: ReadonlyMap<string, string>;
  readonly declarations: readonly string[];
}

function collectSharedDefinitions(tools: readonly PlannedTool[]): SharedDefinitions {
  const schema = new Map<string, string>();
  const codec = new Map<string, string>();
  const declarations: string[] = [];
  const usedNames = new Set<string>();
  const plans = tools.flatMap((tool) =>
    [tool.plan.input, tool.plan.success, tool.plan.errors].filter(
      (plan): plan is JsonWirePlan => plan !== undefined,
    ),
  );
  const collect = (
    document: unknown,
    property: "$defs" | "definitions",
    target: Map<string, string>,
    suffix: string,
  ): void => {
    if (!isSchemaRecord(document) || !isSchemaRecord(document[property])) return;
    for (const [definitionName, definition] of Object.entries(document[property])) {
      const key = JSON.stringify(definition);
      if (target.has(key)) continue;
      const base = typescriptIdentifier(
        camelCase(`${definitionName}${suffix}Definition`),
        `${suffix}Definition`,
      );
      let identifier = base;
      let index = 2;
      while (usedNames.has(identifier)) identifier = `${base}${index++}`;
      usedNames.add(identifier);
      target.set(key, identifier);
      declarations.push(`const ${identifier} = ${typescriptString(definition)} as const;`);
    }
  };
  for (const plan of plans) {
    collect(plan.schema, "$defs", schema, "Schema");
    if (plan.codec) collect(plan.codec, "definitions", codec, "Codec");
  }
  return { schema, codec, declarations };
}

function emitSharedDocument(
  document: unknown,
  property: "$defs" | "definitions",
  identifiers: ReadonlyMap<string, string>,
): string {
  if (!isSchemaRecord(document) || !isSchemaRecord(document[property])) {
    return typescriptString(document);
  }
  const members = Object.entries(document)
    .filter(([name]) => name !== property)
    .map(([name, value]) => `${typescriptString(name)}: ${typescriptString(value)}`);
  const definitions = Object.entries(document[property])
    .map(([name, definition]) => {
      const identifier = identifiers.get(JSON.stringify(definition));
      return `${typescriptString(name)}: ${identifier ?? typescriptString(definition)}`;
    })
    .join(", ");
  members.push(`${typescriptString(property)}: { ${definitions} }`);
  return `{ ${members.join(", ")} }`;
}

function emitServer(server: PlannedServer, launchers: readonly McpLauncher[]): string {
  const implementation = {
    name: server.plan.name,
    version: server.metadata.version,
    ...(server.metadata.icons ? { icons: normalizeIcons(server.metadata.icons) } : {}),
    ...(server.metadata.websiteUrl ? { websiteUrl: String(server.metadata.websiteUrl) } : {}),
  };

  const configuredApplicationType =
    server.modes.native && server.modes.httpBridge
      ? `NativeMcpApplication<${server.symbolName}McpHandlers> | McpHttpBridgeApplication`
      : server.modes.native
        ? `NativeMcpApplication<${server.symbolName}McpHandlers>`
        : "McpHttpBridgeApplication";
  const usesHttpTransport = launchers.some((launcher) => launcher !== "stdio");
  const usesStdioTransport = launchers.includes("stdio");
  const transportFields = [
    ...(usesHttpTransport ? ["readonly http?: McpHttpServerOptions;"] : []),
    ...(usesStdioTransport ? ["readonly stdio?: McpStdioOptions;"] : []),
  ];
  const applicationType =
    transportFields.length > 0
      ? `(${configuredApplicationType}) & { ${transportFields.join(" ")} }`
      : configuredApplicationType;
  const exportedAliases = server.tools.flatMap(operationExportedAliases).join(", ");
  const applicationImports = [
    "type McpHandlersFor",
    ...(server.modes.native ? ["type NativeMcpApplication"] : []),
  ];
  const bridgeImports = server.modes.httpBridge
    ? `import {
  createMcpHttpBridgeApplication,
  type McpHttpBridgeApplication,
} from "@typespex/mcp-http-bridge";
import { mcpHttpBridgeOperations } from "./${server.fileNames.httpClient}.js";`
    : "";
  const transportImports = [
    ...(usesHttpTransport
      ? ['import type { McpHttpServerOptions } from "@typespex/mcp-transport-http";']
      : []),
    ...(usesStdioTransport
      ? ['import type { McpStdioOptions } from "@typespex/mcp-transport-stdio";']
      : []),
  ].join("\n");
  const serverApplication = server.modes.httpBridge
    ? `const serverApplication =
    application.kind === "http-bridge"
      ? createMcpHttpBridgeApplication(mcpHttpBridgeOperations, application)
      : application;`
    : "const serverApplication = application;";

  return `// Generated by @typespex/mcp-emitter. Do not edit.
import {
  createMcpServer,
  ${applicationImports.join(",\n  ")},
} from "@typespex/mcp-server";
${bridgeImports}
${transportImports}
import { mcpTools } from "./${server.fileNames.operations}.js";
export type { ${exportedAliases} } from "./${server.fileNames.operations}.js";

export type ${server.symbolName}McpHandlers = McpHandlersFor<typeof mcpTools>;

export type ${server.symbolName}McpApplication = ${applicationType};

export function define${server.symbolName}McpApplication<const Application extends ${server.symbolName}McpApplication>(
  application: Application,
): Application {
  return application;
}

export function create${server.symbolName}McpServer(application: ${server.symbolName}McpApplication) {
  ${serverApplication}
  return createMcpServer(
    {
      implementation: ${typescriptString(implementation)},
      ${server.metadata.instructions ? `instructions: ${typescriptString(server.metadata.instructions)},` : ""}
    },
    mcpTools,
    serverApplication,
  );
}
`;
}

function operationExportedAliases(tool: PlannedTool): string[] {
  const aliases = [
    `${tool.symbolName}Input`,
    `${tool.symbolName}Success`,
    `${tool.symbolName}Output`,
    `${tool.symbolName}Error`,
  ];
  if (tool.plan.input.wireType !== tool.plan.input.semanticType) {
    aliases.push(`${tool.symbolName}InputWire`);
  }
  if (tool.plan.success && tool.plan.success.wireType !== tool.plan.success.semanticType) {
    aliases.push(`${tool.symbolName}SuccessWire`);
  }
  if (tool.plan.errors && tool.plan.errors.wireType !== tool.plan.errors.semanticType) {
    aliases.push(`${tool.symbolName}ErrorWire`);
  }
  return aliases;
}

function emitLauncher(server: PlannedServer, launcher: McpLauncher): string {
  const module = server.applicationModule ?? "./application.js";
  const common = `// Generated by @typespex/mcp-emitter. Do not edit.
import applicationDefinition from ${typescriptString(module)};
import {
  create${server.symbolName}McpServer,
  type ${server.symbolName}McpApplication,
} from "./${server.fileNames.server}.js";

const application: ${server.symbolName}McpApplication = applicationDefinition;
`;
  const factory = `() => create${server.symbolName}McpServer(application)`;
  switch (launcher) {
    case "stdio":
      return `${common}import { serveMcpStdio } from "@typespex/mcp-transport-stdio";

export const ${camelCase(server.symbolName)}McpStdioServer = serveMcpStdio(
  ${factory},
  application.stdio,
);
`;
    case "node":
      return `${common}import { createServer } from "node:http";
import { toNodeHandler } from "@typespex/adapter-node";
import {
  createMcpHttpHandler,
  resolveMcpHttpServerOptions,
} from "@typespex/mcp-transport-http";

const options = resolveMcpHttpServerOptions(application.http);
const mcpHandler = createMcpHttpHandler(${factory}, application.http);
const nodeHandler = toNodeHandler({ handle: mcpHandler.fetch });
let closeMcpHandlerPromise: Promise<void> | undefined;
const closeMcpHandler = () => (closeMcpHandlerPromise ??= mcpHandler.close());
export const ${camelCase(server.symbolName)}McpNodeServer = createServer(
  (request, response) => void nodeHandler(request, response),
);
${camelCase(server.symbolName)}McpNodeServer.on("close", () => void closeMcpHandler());
try {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      ${camelCase(server.symbolName)}McpNodeServer.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      ${camelCase(server.symbolName)}McpNodeServer.off("error", onError);
      resolve();
    };
    ${camelCase(server.symbolName)}McpNodeServer.once("error", onError);
    ${camelCase(server.symbolName)}McpNodeServer.once("listening", onListening);
    ${camelCase(server.symbolName)}McpNodeServer.listen(options.port, options.host);
  });
} catch (error) {
  await closeMcpHandler();
  throw error;
}

export async function close${server.symbolName}McpNodeServer(): Promise<void> {
  if (${camelCase(server.symbolName)}McpNodeServer.listening) {
    await new Promise<void>((resolve, reject) => {
      ${camelCase(server.symbolName)}McpNodeServer.close((error) =>
        error ? reject(error) : resolve(),
      );
    });
  }
  await closeMcpHandler();
}
`;
    case "bun":
      return `${common}import { toBunHandler } from "@typespex/adapter-bun";
import {
  createMcpHttpHandler,
  resolveMcpHttpServerOptions,
} from "@typespex/mcp-transport-http";

const options = resolveMcpHttpServerOptions(application.http);
const mcpHandler = createMcpHttpHandler(${factory}, application.http);
const bunHandler = toBunHandler({ handle: mcpHandler.fetch });
export const ${camelCase(server.symbolName)}McpBunServer = Bun.serve({
  hostname: options.host,
  port: options.port,
  fetch: bunHandler.fetch,
  error(error) {
    options.onError?.(error);
    return new Response("Internal server error.", { status: 500 });
  },
});
let closePromise: Promise<void> | undefined;
export function close${server.symbolName}McpBunServer(): Promise<void> {
  return (closePromise ??= (async () => {
    try {
      await ${camelCase(server.symbolName)}McpBunServer.stop(true);
    } finally {
      await mcpHandler.close();
    }
  })());
}
`;
    case "express":
      return `${common}import {
  toExpressHandler,
  type ExpressRequestHandler,
} from "@typespex/adapter-express";
import { createMcpHttpHandler } from "@typespex/mcp-transport-http";

const mcpHandler = createMcpHttpHandler(${factory}, application.http);
export const ${camelCase(server.symbolName)}McpExpressHandler: ExpressRequestHandler = toExpressHandler({
  handle: mcpHandler.fetch,
});
let closePromise: Promise<void> | undefined;
export const close${server.symbolName}McpExpressHandler = () =>
  (closePromise ??= mcpHandler.close());
`;
    case "hono":
      return `${common}import { toHonoApp } from "@typespex/adapter-hono";
import { createMcpHttpHandler } from "@typespex/mcp-transport-http";

const mcpHandler = createMcpHttpHandler(${factory}, application.http);
export const ${camelCase(server.symbolName)}McpHonoApp = toHonoApp({
  handle: mcpHandler.fetch,
});
let closePromise: Promise<void> | undefined;
export const close${server.symbolName}McpHonoApp = () =>
  (closePromise ??= mcpHandler.close());
`;
  }
}

function emitHttpClient(server: PlannedServer): string {
  const operations = Object.fromEntries(
    server.tools.flatMap((tool) =>
      tool.http ? [[tool.name, runtimeHttpOperation(tool.http)] as const] : [],
    ),
  );
  return `// Generated by @typespex/mcp-emitter. Do not edit.
import type { HttpBridgeOperation } from "@typespex/mcp-http-bridge";

export const mcpHttpBridgeOperations = ${typescriptString(operations)} as const satisfies Readonly<Record<string, HttpBridgeOperation>>;
`;
}

function runtimeHttpOperation(plan: HttpWireOperationPlan): unknown {
  return {
    version: plan.version,
    id: plan.operationId,
    method: plan.method,
    path: plan.path,
    ...(plan.literalQuery ? { literalQuery: plan.literalQuery } : {}),
    parameters: plan.parameters.map((parameter) => ({
      source: parameter.source,
      name: parameter.wireName,
      location: parameter.location,
      required: parameter.required,
      ...(parameter.style ? { style: parameter.style } : {}),
      ...(parameter.explode !== undefined ? { explode: parameter.explode } : {}),
      ...(parameter.allowReserved !== undefined ? { allowReserved: parameter.allowReserved } : {}),
      ...(parameter.value ? { value: parameter.value } : {}),
    })),
    ...(plan.requestBody
      ? {
          body: {
            ...(plan.requestBody.source ? { source: plan.requestBody.source } : {}),
            ...(plan.requestBody.fields ? { fields: plan.requestBody.fields } : {}),
            kind: plan.requestBody.kind,
            ...(plan.requestBody.contentTypeSource
              ? { contentTypeSource: plan.requestBody.contentTypeSource }
              : {}),
            ...(plan.requestBody.mediaTypes ? { mediaTypes: plan.requestBody.mediaTypes } : {}),
            ...(plan.requestBody.multipartParts
              ? { multipartParts: plan.requestBody.multipartParts }
              : {}),
            ...(plan.requestBody.value ? { value: plan.requestBody.value } : {}),
            ...(!plan.requestBody.contentTypeSource && plan.requestBody.contentTypes[0]
              ? { contentType: plan.requestBody.contentTypes[0] }
              : {}),
          },
        }
      : {}),
    responses: plan.responses.map((response) => ({
      statuses: response.statusCodes,
      ...(response.contentTypes.length > 0 ? { mediaTypes: response.contentTypes } : {}),
      kind: response.kind,
      ...(response.bodyValue ? { bodyValue: response.bodyValue } : {}),
      ...(response.multipartParts ? { multipartParts: response.multipartParts } : {}),
      ...(response.error ? { error: true } : {}),
      ...(response.bodyTarget ? { bodyTarget: response.bodyTarget } : {}),
      ...(response.statusTarget ? { statusTarget: response.statusTarget } : {}),
      ...(response.contentTypeTarget ? { contentTypeTarget: response.contentTypeTarget } : {}),
      ...(response.headers
        ? {
            headers: response.headers.map((header) => ({
              name: header.wireName,
              target: header.target,
              ...(header.collection ? { collection: true } : {}),
              ...(header.value ? { value: header.value } : {}),
            })),
          }
        : {}),
    })),
    ...(plan.servers ? { servers: plan.servers } : {}),
    ...(plan.auth ? { auth: plan.auth } : {}),
  };
}

function artifact(
  server: PlannedServer,
  artifactName: string,
  fileName: string,
  content: string,
): ArtifactPlan {
  return {
    version: COMPILER_PLAN_VERSION,
    artifact: `${server.plan.name}.${artifactName}`,
    fileName: `${fileName}.ts`,
    outputDir: server.outputDir,
    content,
  };
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

function resolveModes(option: McpEmitterOptions["mode"]): ResolvedModes {
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

function schemasDefinitelyDisjoint(success: JsonWirePlan, error: JsonWirePlan): boolean {
  return schemaNodesDefinitelyDisjoint(
    success.schema,
    success.schema,
    error.schema,
    error.schema,
    new Set(),
  );
}

function schemaNodesDefinitelyDisjoint(
  left: unknown,
  leftDocument: unknown,
  right: unknown,
  rightDocument: unknown,
  seen: Set<string>,
): boolean {
  if (left === false || right === false) return true;
  if (left === true || right === true) return false;
  if (!isSchemaRecord(left) || !isSchemaRecord(right)) return false;
  const resolvedLeft = resolveLocalSchemaRef(left, leftDocument);
  const resolvedRight = resolveLocalSchemaRef(right, rightDocument);
  if (resolvedLeft !== left || resolvedRight !== right) {
    const key = `${schemaIdentity(resolvedLeft)}|${schemaIdentity(resolvedRight)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return schemaNodesDefinitelyDisjoint(
      resolvedLeft,
      leftDocument,
      resolvedRight,
      rightDocument,
      seen,
    );
  }

  const leftAlternatives = Array.isArray(left.anyOf) ? left.anyOf : [left];
  const rightAlternatives = Array.isArray(right.anyOf) ? right.anyOf : [right];
  if (leftAlternatives.length > 1 || rightAlternatives.length > 1) {
    return leftAlternatives.every((leftAlternative) =>
      rightAlternatives.every((rightAlternative) =>
        schemaNodesDefinitelyDisjoint(
          leftAlternative,
          leftDocument,
          rightAlternative,
          rightDocument,
          new Set(seen),
        ),
      ),
    );
  }

  if ("const" in left || "const" in right) {
    if ("const" in left && "const" in right) return !Object.is(left.const, right.const);
    const literal = "const" in left ? left.const : right.const;
    const other = "const" in left ? right : left;
    const otherDocument = "const" in left ? rightDocument : leftDocument;
    return schemaDefinitelyRejectsLiteral(other, otherDocument, literal, new Set(seen));
  }
  if (Array.isArray(left.enum) || Array.isArray(right.enum)) {
    if (Array.isArray(left.enum) && Array.isArray(right.enum)) {
      const rightValues = right.enum as unknown[];
      return left.enum.every(
        (value) => !rightValues.some((candidate) => Object.is(value, candidate)),
      );
    }
    const values = (Array.isArray(left.enum) ? left.enum : right.enum) as unknown[];
    const other = Array.isArray(left.enum) ? right : left;
    const otherDocument = Array.isArray(left.enum) ? rightDocument : leftDocument;
    return values.every((value) =>
      schemaDefinitelyRejectsLiteral(other, otherDocument, value, new Set(seen)),
    );
  }
  const leftTypes = schemaTypes(left);
  const rightTypes = schemaTypes(right);
  if (leftTypes && rightTypes && typeSetsDefinitelyDisjoint(leftTypes, rightTypes)) return true;
  const commonTypes = commonSchemaTypes(leftTypes, rightTypes);
  if (commonTypes.includes("object") || (left.properties && right.properties)) {
    return objectSchemasDefinitelyDisjoint(left, leftDocument, right, rightDocument, seen);
  }
  if (commonTypes.includes("number") || commonTypes.includes("integer")) {
    return numericSchemasDefinitelyDisjoint(left, right);
  }
  if (commonTypes.includes("string")) {
    return stringRangesDefinitelyDisjoint(left, right);
  }
  if (commonTypes.includes("array")) {
    const leftMinimum = numberKeyword(left.minItems, 0);
    const rightMinimum = numberKeyword(right.minItems, 0);
    const leftMaximum = numberKeyword(left.maxItems, Number.POSITIVE_INFINITY);
    const rightMaximum = numberKeyword(right.maxItems, Number.POSITIVE_INFINITY);
    if (Math.max(leftMinimum, rightMinimum) > Math.min(leftMaximum, rightMaximum)) return true;
    return (
      Math.max(leftMinimum, rightMinimum) > 0 &&
      schemaNodesDefinitelyDisjoint(
        left.items ?? true,
        leftDocument,
        right.items ?? true,
        rightDocument,
        seen,
      )
    );
  }
  return false;
}

function objectSchemasDefinitelyDisjoint(
  left: Record<string, unknown>,
  leftDocument: unknown,
  right: Record<string, unknown>,
  rightDocument: unknown,
  seen: Set<string>,
): boolean {
  const leftProperties = isSchemaRecord(left.properties) ? left.properties : {};
  const rightProperties = isSchemaRecord(right.properties) ? right.properties : {};
  const leftRequired = new Set(Array.isArray(left.required) ? left.required.filter(isString) : []);
  const rightRequired = new Set(
    Array.isArray(right.required) ? right.required.filter(isString) : [],
  );
  if (
    left.additionalProperties === false &&
    [...rightRequired].some((property) => !(property in leftProperties))
  ) {
    return true;
  }
  if (
    right.additionalProperties === false &&
    [...leftRequired].some((property) => !(property in rightProperties))
  ) {
    return true;
  }
  for (const property of new Set([...leftRequired, ...rightRequired])) {
    const leftSchema = leftProperties[property];
    const rightSchema = rightProperties[property];
    if (leftSchema === undefined || rightSchema === undefined) continue;
    if (
      schemaNodesDefinitelyDisjoint(
        leftSchema,
        leftDocument,
        rightSchema,
        rightDocument,
        new Set(seen),
      )
    ) {
      return true;
    }
  }
  return false;
}

function numericSchemasDefinitelyDisjoint(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftRange = numericRange(left);
  const rightRange = numericRange(right);
  if (leftRange.minimum > rightRange.maximum || rightRange.minimum > leftRange.maximum) return true;
  if (leftRange.minimum === rightRange.maximum) {
    return leftRange.minimumExclusive || rightRange.maximumExclusive;
  }
  if (rightRange.minimum === leftRange.maximum) {
    return rightRange.minimumExclusive || leftRange.maximumExclusive;
  }
  return false;
}

function stringRangesDefinitelyDisjoint(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const minimum = Math.max(numberKeyword(left.minLength, 0), numberKeyword(right.minLength, 0));
  const maximum = Math.min(
    numberKeyword(left.maxLength, Number.POSITIVE_INFINITY),
    numberKeyword(right.maxLength, Number.POSITIVE_INFINITY),
  );
  return minimum > maximum;
}

function schemaDefinitelyRejectsLiteral(
  schema: unknown,
  document: unknown,
  value: unknown,
  seen: Set<string>,
): boolean {
  if (schema === false) return true;
  if (schema === true || !isSchemaRecord(schema)) return false;
  const resolved = resolveLocalSchemaRef(schema, document);
  if (resolved !== schema) {
    const key = schemaIdentity(resolved);
    if (seen.has(key)) return false;
    seen.add(key);
    return schemaDefinitelyRejectsLiteral(resolved, document, value, seen);
  }
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.every((variant) =>
      schemaDefinitelyRejectsLiteral(variant, document, value, new Set(seen)),
    );
  }
  if ("const" in schema && !Object.is(schema.const, value)) return true;
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value)))
    return true;
  const types = schemaTypes(schema);
  const literalType = jsonTypeOf(value);
  if (types && !types.some((type) => schemaTypeAccepts(type, literalType))) return true;
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return true;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return true;
  }
  if (typeof value === "number") {
    const range = numericRange(schema);
    if (value < range.minimum || value > range.maximum) return true;
    if (value === range.minimum && range.minimumExclusive) return true;
    if (value === range.maximum && range.maximumExclusive) return true;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return true;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return true;
  }
  return false;
}

function typeSetsDefinitelyDisjoint(left: readonly string[], right: readonly string[]): boolean {
  return !left.some((leftType) =>
    right.some(
      (rightType) =>
        leftType === rightType ||
        (leftType === "number" && rightType === "integer") ||
        (leftType === "integer" && rightType === "number"),
    ),
  );
}

function commonSchemaTypes(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): string[] {
  if (!left && !right) return [];
  if (!left) return [...right!];
  if (!right) return [...left];
  const result = new Set<string>();
  for (const leftType of left) {
    for (const rightType of right) {
      if (leftType === rightType) result.add(leftType);
      else if (
        (leftType === "number" && rightType === "integer") ||
        (leftType === "integer" && rightType === "number")
      ) {
        result.add("integer");
      }
    }
  }
  return [...result];
}

function schemaTypeAccepts(schemaType: string, literalType: string): boolean {
  return schemaType === literalType || (schemaType === "number" && literalType === "integer");
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value === "object" ? "object" : typeof value;
}

function numericRange(schema: Record<string, unknown>): {
  minimum: number;
  maximum: number;
  minimumExclusive: boolean;
  maximumExclusive: boolean;
} {
  const exclusiveMinimum =
    typeof schema.exclusiveMinimum === "number" ? schema.exclusiveMinimum : undefined;
  const exclusiveMaximum =
    typeof schema.exclusiveMaximum === "number" ? schema.exclusiveMaximum : undefined;
  return {
    minimum: exclusiveMinimum ?? numberKeyword(schema.minimum, Number.NEGATIVE_INFINITY),
    maximum: exclusiveMaximum ?? numberKeyword(schema.maximum, Number.POSITIVE_INFINITY),
    minimumExclusive: exclusiveMinimum !== undefined,
    maximumExclusive: exclusiveMaximum !== undefined,
  };
}

function resolveLocalSchemaRef(schema: Record<string, unknown>, document: unknown): unknown {
  if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/$defs/")) return schema;
  if (!isSchemaRecord(document) || !isSchemaRecord(document.$defs)) return schema;
  return document.$defs[schema.$ref.slice("#/$defs/".length)] ?? schema;
}

function schemaTypes(schema: Record<string, unknown>): string[] | undefined {
  return typeof schema.type === "string"
    ? [schema.type]
    : Array.isArray(schema.type)
      ? schema.type.filter(isString)
      : undefined;
}

function schemaIdentity(schema: unknown): string {
  if (!isSchemaRecord(schema)) return String(schema);
  return `${String(schema.$ref ?? "")}:${String(schema.type ?? "")}:${Object.keys(schema).join(",")}`;
}

function numberKeyword(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function operationIsWithin(operation: Operation, namespace: Namespace): boolean {
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

function normalizeIcons(icons: McpServerMetadata["icons"] | McpToolMetadata["icons"]): unknown[] {
  return (icons ?? []).map((icon) => ({
    src: String(icon.src),
    ...(icon.mimeType ? { mimeType: icon.mimeType } : {}),
    ...(icon.sizes ? { sizes: [...icon.sizes] } : {}),
  }));
}
