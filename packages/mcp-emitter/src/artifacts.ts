import { COMPILER_PLAN_VERSION, type ArtifactPlan } from "@typespex/compiler-core/unstable";
import type { McpLauncher } from "./lib.js";
import { renderOperations } from "./render-operations.js";
import { renderHttpBridge, renderLauncher, renderServer } from "./render-server.js";
import type { PlannedServer } from "./types.js";

export function createServerArtifacts(
  server: PlannedServer,
  launchers: readonly McpLauncher[],
): ArtifactPlan[] {
  const artifacts: ArtifactPlan[] = [
    artifact(server, "models", server.fileNames.models, server.planner.emitModels()),
    artifact(server, "mcp-operations", server.fileNames.operations, renderOperations(server)),
    artifact(server, "mcp-server", server.fileNames.server, renderServer(server, launchers)),
  ];

  if (server.modes.httpBridge) {
    artifacts.push(
      artifact(server, "mcp-http-bridge", server.fileNames.httpBridge, renderHttpBridge(server)),
    );
  }
  for (const launcher of launchers) {
    artifacts.push(
      artifact(
        server,
        `mcp-${launcher}`,
        server.fileNames[launcher],
        renderLauncher(server, launcher),
      ),
    );
  }
  return artifacts;
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
