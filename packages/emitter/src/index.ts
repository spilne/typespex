import type { EmitContext } from "@typespec/compiler";
import { emitFile, resolvePath } from "@typespec/compiler";
import { getAllHttpServices } from "@typespec/http";
import { $lib, type TypespexEmitterOptions } from "./lib.js";
import { createEmitterContext } from "./ctx.js";
import { emitModels } from "./emit-models.js";
import { emitServerHints } from "./emit-server-hints.js";
import { emitServerOperations } from "./emit-server-operations.js";
import { emitServer } from "./emit-server.js";
import { emitServerRouter } from "./emit-server-router.js";

export { $lib } from "./lib.js";

export async function $onEmit(
  context: EmitContext<TypespexEmitterOptions>,
): Promise<void> {
  const { program, emitterOutputDir } = context;

  const [services, diagnostics] = getAllHttpServices(program);
  for (const d of diagnostics) {
    program.reportDiagnostic(d);
  }

  if (services.length === 0) {
    $lib.reportDiagnostic(program, {
      code: "no-services",
      target: program.getGlobalNamespaceType(),
    });
    return;
  }

  for (const service of services) {
    const ctx = createEmitterContext(program, service, context.options);

    // Gather all HTTP operations
    const httpOperations = service.operations;

    // 1. Emit model interfaces
    const modelsContent = emitModels(ctx);
    await emitFile(program, {
      path: resolvePath(emitterOutputDir, "models.ts"),
      content: modelsContent,
    });

    // 2. Emit server hint keys used by generated metadata
    const serverHintsContent = emitServerHints(ctx, httpOperations);
    await emitFile(program, {
      path: resolvePath(emitterOutputDir, "server-hints.ts"),
      content: serverHintsContent,
    });

    // 3. Emit FP/server operation runtime values
    const serverOperationsContent = emitServerOperations(ctx, httpOperations);
    await emitFile(program, {
      path: resolvePath(emitterOutputDir, "server-operations.ts"),
      content: serverOperationsContent,
    });

    // 4. Emit FP/server handler interfaces
    const serverContent = emitServer(ctx, httpOperations);
    await emitFile(program, {
      path: resolvePath(emitterOutputDir, "server.ts"),
      content: serverContent,
    });

    // 5. Emit FP/server router wiring
    const serverRouterContent = emitServerRouter(ctx, httpOperations);
    await emitFile(program, {
      path: resolvePath(emitterOutputDir, "server-router.ts"),
      content: serverRouterContent,
    });
  }
}
