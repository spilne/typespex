import { emitFile, getNamespaceFullName, resolvePath, type EmitContext } from "@typespec/compiler";
import {
  ArtifactFormatError,
  assertUniqueArtifactPaths,
  formatTypeScriptArtifacts,
  type ArtifactPlan,
} from "@typespex/compiler-core/unstable";
import {
  listMcpServers,
  listMcpTools,
  type McpServerMetadata,
  type McpToolMetadata,
} from "@typespex/mcp";
import { createServerArtifacts } from "./artifacts.js";
import {
  discoverNativeStreamTypes,
  loadBridgePlanningContext,
  operationIsWithin,
  planServer,
  resolveModes,
} from "./planning.js";
import { $lib, type McpEmitterOptions, type McpLauncher } from "./lib.js";

const DEFAULT_LAUNCHERS: readonly McpLauncher[] = [];

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

  const artifacts = planned.flatMap((server) => createServerArtifacts(server, launchers));
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
