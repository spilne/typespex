import type { EmitContext } from "@typespec/compiler";
import { emitFile, resolvePath } from "@typespec/compiler";
import { getAllHttpServices, type HttpService } from "@typespec/http";
import { format } from "oxfmt";
import { $lib, type TypespexEmitterOptions } from "./lib.js";
import { DEFAULT_FILE_NAMES, createEmitterContext, type GeneratedFileNames } from "./ctx.js";
import { emitModels } from "./emit-models.js";
import { emitServerHints } from "./emit-server-hints.js";
import { emitServerOperations } from "./emit-server-operations.js";
import { emitServer } from "./emit-server.js";
import { emitServerRouter } from "./emit-server-router.js";

async function formatTs(fileName: string, content: string): Promise<string> {
  try {
    const result = await format(fileName, content);
    return result.errors.length === 0 ? result.code : content;
  } catch {
    return content;
  }
}

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

  const serviceOutput = resolveServiceOutput(context.options);

  for (const service of services) {
    const layout = createServiceLayout(service, serviceOutput, context.options);
    const ctx = createEmitterContext(program, service, context.options, layout.fileNames);

    // Gather all HTTP operations
    const httpOperations = service.operations;

    const files: Array<[string, string]> = [
      [`${layout.fileNames.models}.ts`, emitModels(ctx)],
      [`${layout.fileNames.serverHints}.ts`, emitServerHints(ctx, httpOperations)],
      [`${layout.fileNames.serverOperations}.ts`, emitServerOperations(ctx, httpOperations)],
      [`${layout.fileNames.server}.ts`, emitServer(ctx, httpOperations)],
      [`${layout.fileNames.serverRouter}.ts`, emitServerRouter(ctx, httpOperations)],
    ];

    for (const [fileName, raw] of files) {
      const content = await formatTs(fileName, raw);
      await emitFile(program, {
        path: resolvePath(emitterOutputDir, layout.outputDir, fileName),
        content,
      });
    }
  }
}

type ResolvedServiceOutput = "flat" | "prefix" | "directory";

interface ServiceLayout {
  readonly outputDir: string;
  readonly fileNames: GeneratedFileNames;
}

function resolveServiceOutput(
  options: TypespexEmitterOptions,
): ResolvedServiceOutput {
  const configured = options["service-output"] ?? "auto";
  if (configured === "auto") return "directory";
  return configured;
}

function createServiceLayout(
  service: HttpService,
  serviceOutput: ResolvedServiceOutput,
  options: TypespexEmitterOptions,
): ServiceLayout {
  const serviceName = service.namespace.name || "Service";
  const tokens = createNameTokens(serviceName);
  const serviceFolderPattern = options["service-folder-pattern"] ?? "{service.kebab}";
  const defaultFileNamePattern = serviceOutput === "prefix"
    ? "{service}.{file}"
    : "{file}";
  const fileNamePattern = options["file-name-pattern"] ?? defaultFileNamePattern;

  if (serviceOutput === "directory") {
    return {
      outputDir: renderNamePattern(serviceFolderPattern, tokens),
      fileNames: renderFileNames(fileNamePattern, tokens),
    };
  }

  if (serviceOutput === "prefix") {
    return {
      outputDir: "",
      fileNames: renderFileNames(fileNamePattern, tokens),
    };
  }

  return {
    outputDir: "",
    fileNames: renderFileNames(fileNamePattern, tokens),
  };
}

interface NameTokens {
  readonly service: string;
  readonly "service.camel": string;
  readonly "service.kebab": string;
  readonly "service.pascal": string;
  readonly "service.snake": string;
}

function renderFileNames(
  pattern: string,
  tokens: NameTokens,
): GeneratedFileNames {
  return {
    models: renderNamePattern(pattern, tokens, DEFAULT_FILE_NAMES.models),
    serverHints: renderNamePattern(pattern, tokens, DEFAULT_FILE_NAMES.serverHints),
    serverOperations: renderNamePattern(pattern, tokens, DEFAULT_FILE_NAMES.serverOperations),
    server: renderNamePattern(pattern, tokens, DEFAULT_FILE_NAMES.server),
    serverRouter: renderNamePattern(pattern, tokens, DEFAULT_FILE_NAMES.serverRouter),
  };
}

function renderNamePattern(
  pattern: string,
  tokens: NameTokens,
  fileName = "",
): string {
  const rendered = pattern.replace(/\{([^}]+)\}/g, (_match, rawToken: string) => {
    const token = rawToken.trim();
    if (token === "file") return fileName;
    return token in tokens ? tokens[token as keyof NameTokens] : "";
  });
  return sanitizeNameSegment(rendered);
}

function createNameTokens(serviceName: string): NameTokens {
  const words = splitNameWords(serviceName);
  return {
    service: serviceName,
    "service.camel": toCamelCase(words),
    "service.kebab": words.map((word) => word.toLowerCase()).join("-"),
    "service.pascal": toPascalCase(words),
    "service.snake": words.map((word) => word.toLowerCase()).join("_"),
  };
}

function splitNameWords(value: string): string[] {
  const withBoundaries = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  const words = withBoundaries.match(/[A-Za-z0-9]+/g) ?? [];
  return words.length > 0 ? words : ["Service"];
}

function toPascalCase(words: readonly string[]): string {
  return words.map(capitalize).join("");
}

function toCamelCase(words: readonly string[]): string {
  const [first = "service", ...rest] = words;
  return `${first.toLowerCase()}${rest.map(capitalize).join("")}`;
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1).toLowerCase()}`;
}

function sanitizeNameSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "Service";
}
