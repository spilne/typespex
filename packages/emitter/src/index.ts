import type { EmitContext } from "@typespec/compiler";
import { emitFile, resolvePath } from "@typespec/compiler";
import { getAllHttpServices, type HttpOperation, type HttpService } from "@typespec/http";
import { format } from "oxfmt";
import { $lib, type TypespexEmitterOptions } from "./lib.js";
import {
  DEFAULT_FILE_NAMES,
  createEmitterContext,
  type EmitterCtx,
  type GeneratedFileNames,
} from "./ctx.js";
import { emitModels } from "./emit-models.js";
import { emitServerHints } from "./emit-server-hints.js";
import { emitServerOperations } from "./emit-server-operations.js";
import { emitServer } from "./emit-server.js";
import { emitServerRouter } from "./emit-server-router.js";
import { reportIgnoredDecorators } from "./report-ignored-decorators.js";

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
  const emissionPlans = services.map((service): ServiceEmissionPlan => {
    const layout = createServiceLayout(service, serviceOutput, context.options);
    return {
      service,
      layout,
      ctx: createEmitterContext(program, service, context.options, layout.fileNames),
      httpOperations: service.operations,
    };
  });

  for (const { ctx, httpOperations } of emissionPlans) {
    reportIgnoredDecorators(ctx, httpOperations);
  }

  if (program.hasError()) return;

  // Render every service before writing anything. Some response diagnostics
  // are discovered while rendering, and an error must not leave partial output.
  const files = emissionPlans.flatMap(({ ctx, httpOperations, layout }) => [
    {
      fileName: `${layout.fileNames.models}.ts`,
      outputDir: layout.outputDir,
      raw: emitModels(ctx),
    },
    {
      fileName: `${layout.fileNames.serverHints}.ts`,
      outputDir: layout.outputDir,
      raw: emitServerHints(ctx, httpOperations),
    },
    {
      fileName: `${layout.fileNames.serverOperations}.ts`,
      outputDir: layout.outputDir,
      raw: emitServerOperations(ctx, httpOperations),
    },
    {
      fileName: `${layout.fileNames.server}.ts`,
      outputDir: layout.outputDir,
      raw: emitServer(ctx, httpOperations),
    },
    {
      fileName: `${layout.fileNames.serverRouter}.ts`,
      outputDir: layout.outputDir,
      raw: emitServerRouter(ctx, httpOperations),
    },
  ]);

  if (program.hasError()) return;

  for (const { fileName, outputDir, raw } of files) {
    const content = await formatTs(fileName, raw);
    await emitFile(program, {
      path: resolvePath(emitterOutputDir, outputDir, fileName),
      content,
    });
  }
}

interface ServiceEmissionPlan {
  readonly service: HttpService;
  readonly layout: ServiceLayout;
  readonly ctx: EmitterCtx;
  readonly httpOperations: HttpOperation[];
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
