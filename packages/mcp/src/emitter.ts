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
  assertUniqueArtifactPaths,
  camelCase,
  createServiceLayout,
  formatTypeScriptArtifacts,
  isVoidType,
  kebabCase,
  pascalCase,
  TypePlanner,
  typescriptIdentifier,
  typescriptProperty,
  typescriptString,
  type ArtifactPlan,
  type HttpWireOperationPlan,
  type JsonWirePlan,
} from "@typespex/codegen/unstable";
import { listMcpServers, listMcpTools } from "./decorators.js";
import {
  analyzeBridgeStreams,
  createHttpWireOperationPlan,
  type HttpPlanningApi,
} from "./http-planner.js";
import { $lib, type McpEmitterOptions, type McpLauncher, type McpMode } from "./lib.js";
import type { McpServerMetadata, McpToolMetadata } from "./types.js";

const DEFAULT_LAUNCHERS: readonly McpLauncher[] = ["stdio", "node", "bun", "express", "hono"];
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const UNSAFE_TOOL_NAMES = new Set(["__proto__", "constructor", "prototype"]);

interface ResolvedModes {
  readonly native: boolean;
  readonly httpBridge: boolean;
}

interface PlannedServer {
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
  readonly metadata: McpToolMetadata;
  readonly operation: Operation;
  readonly name: string;
  readonly symbolName: string;
  readonly input: JsonWirePlan;
  readonly success?: JsonWirePlan;
  readonly errors?: JsonWirePlan;
  readonly allowsVoid: boolean;
  readonly annotations?: McpToolMetadata["annotations"];
  readonly http?: HttpWireOperationPlan;
  readonly successTypes: readonly Type[];
  readonly errorTypes: readonly Type[];
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
        code: "codegen-error",
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
      successPlan && errorPlan && schemasDefinitelyOverlap(successPlan, errorPlan),
    );
    if (requiresTaggedResult) {
      $lib.reportDiagnostic(context.program, {
        code: "ambiguous-tool-result",
        format: { name: toolName },
        target: tool.operation,
      });
    }
    return {
      metadata: tool,
      operation: tool.operation,
      name: toolName,
      symbolName: toolSymbol,
      input: planner.createWirePlan(tool.operation.parameters, { projection: inputProjection }),
      success: successPlan,
      errors: errorPlan,
      allowsVoid,
      annotations: mergeToolAnnotations(tool.annotations, httpOperation?.verb),
      ...(http ? { http } : {}),
      successTypes: success,
      errorTypes: errors,
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
  return {
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
    artifact(server, "mcp-server", server.fileNames.server, emitServer(server)),
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
  const hasHttp = server.tools.some((tool) => tool.http);
  const definitions = server.tools
    .map((tool) => {
      const input = emitSchemaDefinition(`${camelCase(tool.symbolName)}Input`, tool.input);
      const success = tool.success
        ? emitSchemaDefinition(`${camelCase(tool.symbolName)}Success`, tool.success)
        : "";
      const errors = tool.errors
        ? emitSchemaDefinition(`${camelCase(tool.symbolName)}Errors`, tool.errors)
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
        handler: ${typescriptString(tool.name)},
        ${title ? `title: ${typescriptString(title)},` : ""}
        ${description ? `description: ${typescriptString(description)},` : ""}
        ${metadata.icons ? `icons: ${typescriptString(normalizeIcons(metadata.icons))},` : ""}
        ${tool.annotations ? `annotations: ${typescriptString(tool.annotations)},` : ""}
        input: ${camelCase(tool.symbolName)}Input,
        ${tool.success ? `success: ${camelCase(tool.symbolName)}Success,` : ""}
        ${tool.errors ? `errors: ${camelCase(tool.symbolName)}Errors,` : ""}
        ${tool.allowsVoid ? "voidResult: true," : ""}
        ${tool.http ? `http: mcpHttpBridgeOperations[${typescriptString(tool.name)}],` : ""}
      }`;
    })
    .join(",\n");

  return `// Generated by @typespex/mcp. Do not edit.
import { createTypeSpecSchema, type GeneratedMcpTool } from "@typespex/mcp-runtime";
${hasHttp ? `import { mcpHttpBridgeOperations } from "./${server.fileNames.httpClient}.js";` : ""}

${definitions}

export const mcpTools = [
${tools}
] as const satisfies readonly GeneratedMcpTool[];
`;
}

function emitSchemaDefinition(name: string, plan: JsonWirePlan): string {
  return `const ${name} = createTypeSpecSchema({
    schema: ${typescriptString(plan.schema)},
    codec: ${typescriptString(plan.codec)},
  });`;
}

function emitServer(server: PlannedServer): string {
  const imports = server.planner.emittedTypeNames;
  const modelImport =
    imports.length > 0
      ? `import type { ${imports.join(", ")} } from "./${server.fileNames.models}.js";\n`
      : "";
  const aliases = server.tools
    .map((tool) => {
      const input = tool.input.semanticType;
      const success =
        [
          ...(tool.success ? [tool.success.semanticType] : []),
          ...(tool.allowsVoid ? ["void"] : []),
        ].join(" | ") || "never";
      const errors = tool.errorTypes.length === 0 ? "never" : tool.errors!.semanticType;
      return `export type ${tool.symbolName}Input = ${input};
export type ${tool.symbolName}Output = ${success};
export type ${tool.symbolName}Error = ${errors};`;
    })
    .join("\n\n");
  const handlerProperties = server.tools
    .map(
      (tool) =>
        `readonly ${typescriptProperty(tool.name)}: ${tool.requiresTaggedResult ? "McpTaggedToolHandler" : "McpToolHandler"}<${tool.symbolName}Input, ${tool.symbolName}Output, ${tool.symbolName}Error>;`,
    )
    .join("\n  ");
  const implementation = {
    name: server.name,
    version: server.metadata.version,
    ...(server.metadata.icons ? { icons: normalizeIcons(server.metadata.icons) } : {}),
    ...(server.metadata.websiteUrl ? { websiteUrl: String(server.metadata.websiteUrl) } : {}),
  };

  const applicationType = server.modes.native
    ? server.modes.httpBridge
      ? "HybridMcpApplication"
      : "NativeMcpApplication"
    : "HttpBridgeMcpApplication";

  return `// Generated by @typespex/mcp. Do not edit.
${modelImport}import {
  createGeneratedMcpServer,
  defineMcpApplication,
  type ${applicationType},
  type McpTaggedToolHandler,
  type McpToolHandler,
} from "@typespex/mcp-runtime";
import { mcpTools } from "./${server.fileNames.operations}.js";

${aliases}

export interface ${server.symbolName}McpHandlers {
  ${handlerProperties}
}

export type ${server.symbolName}McpApplication = ${applicationType}<${server.symbolName}McpHandlers>;

export const define${server.symbolName}McpApplication = (application: ${server.symbolName}McpApplication): ${server.symbolName}McpApplication =>
  defineMcpApplication(application);

export function create${server.symbolName}McpServer(application: ${server.symbolName}McpApplication) {
  return createGeneratedMcpServer(
    {
      implementation: ${typescriptString(implementation)},
      ${server.metadata.instructions ? `instructions: ${typescriptString(server.metadata.instructions)},` : ""}
    },
    mcpTools,
    application,
  );
}
`;
}

function emitLauncher(server: PlannedServer, launcher: McpLauncher): string {
  const module = server.applicationModule ?? "./application.js";
  const common = `// Generated by @typespex/mcp. Do not edit.
import application from ${typescriptString(module)};
import { create${server.symbolName}McpServer } from "./${server.fileNames.server}.js";
`;
  const factory = `() => create${server.symbolName}McpServer(application)`;
  switch (launcher) {
    case "stdio":
      return `${common}import { serveTypespexStdio } from "@typespex/mcp-runtime/stdio";

serveTypespexStdio(${factory}, application.stdio);
`;
    case "node":
      return `${common}import { runTypespexNodeServer } from "@typespex/mcp-runtime/node";

await runTypespexNodeServer(${factory}, application.http);
`;
    case "bun":
      return `${common}import { runTypespexBunServer } from "@typespex/mcp-runtime/bun";

runTypespexBunServer(${factory}, application.http);
`;
    case "express":
      return `${common}import { createTypespexNodeHandler } from "@typespex/mcp-runtime/node";

export const ${camelCase(server.symbolName)}McpExpressHandler = createTypespexNodeHandler(
  ${factory},
  application.http,
);
`;
    case "hono":
      return `${common}import { createTypespexHonoHandler } from "@typespex/mcp-runtime/hono";

export const ${camelCase(server.symbolName)}McpHonoHandler = createTypespexHonoHandler(
  ${factory},
  application.http,
);
`;
  }
}

function emitHttpClient(server: PlannedServer): string {
  const operations = Object.fromEntries(
    server.tools.flatMap((tool) =>
      tool.http ? [[tool.name, runtimeHttpOperation(tool.http)] as const] : [],
    ),
  );
  return `// Generated by @typespex/mcp. Do not edit.
import type { HttpBridgeOperation } from "@typespex/mcp-runtime/http-bridge";

export const mcpHttpBridgeOperations = ${typescriptString(operations)} as const satisfies Readonly<Record<string, HttpBridgeOperation>>;
`;
}

function runtimeHttpOperation(plan: HttpWireOperationPlan): unknown {
  return {
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
    artifact: `${server.name}.${artifactName}`,
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

function schemasDefinitelyOverlap(success: JsonWirePlan, error: JsonWirePlan): boolean {
  return schemaNodesOverlap(success.schema, success.schema, error.schema, error.schema, new Set());
}

function schemaNodesOverlap(
  left: unknown,
  leftDocument: unknown,
  right: unknown,
  rightDocument: unknown,
  seen: Set<string>,
): boolean {
  if (left === false || right === false) return false;
  if (left === true || right === true) return true;
  if (!isSchemaRecord(left) || !isSchemaRecord(right)) return false;
  const resolvedLeft = resolveLocalSchemaRef(left, leftDocument);
  const resolvedRight = resolveLocalSchemaRef(right, rightDocument);
  if (resolvedLeft !== left || resolvedRight !== right) {
    const key = `${schemaIdentity(resolvedLeft)}|${schemaIdentity(resolvedRight)}`;
    if (seen.has(key)) return true;
    seen.add(key);
    return schemaNodesOverlap(resolvedLeft, leftDocument, resolvedRight, rightDocument, seen);
  }

  const leftAlternatives = Array.isArray(left.anyOf) ? left.anyOf : [left];
  const rightAlternatives = Array.isArray(right.anyOf) ? right.anyOf : [right];
  if (leftAlternatives.length > 1 || rightAlternatives.length > 1) {
    return leftAlternatives.some((leftAlternative) =>
      rightAlternatives.some((rightAlternative) =>
        schemaNodesOverlap(
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
    return "const" in left && "const" in right && Object.is(left.const, right.const);
  }
  if (Array.isArray(left.enum) && Array.isArray(right.enum)) {
    const leftValues = left.enum;
    const rightValues = right.enum;
    return leftValues.some((value) => rightValues.some((candidate) => Object.is(value, candidate)));
  }
  const leftTypes = schemaTypes(left);
  const rightTypes = schemaTypes(right);
  if (leftTypes && rightTypes && !leftTypes.some((type) => rightTypes.includes(type))) return false;
  const commonType = leftTypes?.find((type) => rightTypes?.includes(type));
  if (commonType === "object" || (left.properties && right.properties)) {
    return objectSchemasOverlap(left, leftDocument, right, rightDocument, seen);
  }
  if (commonType === "number" || commonType === "integer") {
    return numericSchemasOverlap(left, right);
  }
  if (commonType === "string") {
    if (left.pattern || right.pattern) return left.pattern === right.pattern;
    return stringRangesOverlap(left, right);
  }
  if (commonType === "array") {
    const leftMinimum = numberKeyword(left.minItems, 0);
    const rightMinimum = numberKeyword(right.minItems, 0);
    if (leftMinimum === 0 && rightMinimum === 0) return true;
    return schemaNodesOverlap(
      left.items ?? true,
      leftDocument,
      right.items ?? true,
      rightDocument,
      seen,
    );
  }
  return commonType !== undefined && commonType !== "never";
}

function objectSchemasOverlap(
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
    return false;
  }
  if (
    right.additionalProperties === false &&
    [...leftRequired].some((property) => !(property in rightProperties))
  ) {
    return false;
  }
  for (const property of new Set([...leftRequired, ...rightRequired])) {
    const leftSchema = leftProperties[property];
    const rightSchema = rightProperties[property];
    if (leftSchema === undefined || rightSchema === undefined) continue;
    if (!schemaNodesOverlap(leftSchema, leftDocument, rightSchema, rightDocument, new Set(seen))) {
      return false;
    }
  }
  return true;
}

function numericSchemasOverlap(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftMinimum = numberKeyword(left.minimum, Number.NEGATIVE_INFINITY);
  const rightMinimum = numberKeyword(right.minimum, Number.NEGATIVE_INFINITY);
  const leftMaximum = numberKeyword(left.maximum, Number.POSITIVE_INFINITY);
  const rightMaximum = numberKeyword(right.maximum, Number.POSITIVE_INFINITY);
  return Math.max(leftMinimum, rightMinimum) <= Math.min(leftMaximum, rightMaximum);
}

function stringRangesOverlap(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const minimum = Math.max(numberKeyword(left.minLength, 0), numberKeyword(right.minLength, 0));
  const maximum = Math.min(
    numberKeyword(left.maxLength, Number.POSITIVE_INFINITY),
    numberKeyword(right.maxLength, Number.POSITIVE_INFINITY),
  );
  return minimum <= maximum;
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
