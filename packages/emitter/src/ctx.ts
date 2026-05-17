import type { Program } from "@typespec/compiler";
import type { HttpService } from "@typespec/http";
import type { TypespexEmitterOptions } from "./lib.js";

export interface EmitterCtx {
  program: Program;
  service: HttpService;
  serviceName: string;
  options: TypespexEmitterOptions;
  fileNames: GeneratedFileNames;
  /** Track which models have been emitted to avoid duplicates */
  emittedModels: Set<string>;
}

export interface GeneratedFileNames {
  models: string;
  serverHints: string;
  serverOperations: string;
  server: string;
  serverRouter: string;
}

export const DEFAULT_FILE_NAMES: GeneratedFileNames = {
  models: "models",
  serverHints: "server-hints",
  serverOperations: "server-operations",
  server: "server",
  serverRouter: "server-router",
};

export function createEmitterContext(
  program: Program,
  service: HttpService,
  options: TypespexEmitterOptions,
  fileNames: GeneratedFileNames = DEFAULT_FILE_NAMES,
): EmitterCtx {
  const serviceName =
    service.namespace.name || "Service";
  return {
    program,
    service,
    serviceName,
    options,
    fileNames,
    emittedModels: new Set(),
  };
}
