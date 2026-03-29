import type { Program } from "@typespec/compiler";
import type { HttpService } from "@typespec/http";
import type { TypespexEmitterOptions } from "./lib.js";

export interface EmitterCtx {
  program: Program;
  service: HttpService;
  serviceName: string;
  options: TypespexEmitterOptions;
  /** Track which models have been emitted to avoid duplicates */
  emittedModels: Set<string>;
}

export function createEmitterContext(
  program: Program,
  service: HttpService,
  options: TypespexEmitterOptions,
): EmitterCtx {
  const serviceName =
    service.namespace.name || "Service";
  return {
    program,
    service,
    serviceName,
    options,
    emittedModels: new Set(),
  };
}
