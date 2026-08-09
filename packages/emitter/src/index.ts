import type { EmitContext } from "@typespec/compiler";
import { emitFile, resolvePath } from "@typespec/compiler";
import { getAllHttpServices, type HttpOperation, type HttpService } from "@typespec/http";
import { format } from "oxfmt";
import { $lib, type TypespexEmitterOptions } from "./lib.js";
import { getNamespaceFullName } from "./namespace-names.js";
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
import { reportUnsupportedResponseStatusContracts } from "./emit-server-common.js";
import { reportIgnoredDecorators } from "./report-ignored-decorators.js";
import { getServerHttpOperations } from "./operation-surface.js";
import { reportRequestInputCollisions } from "./request-input-plan.js";
import { reportRouteConflicts } from "./route-selection.js";
import { reportUnsupportedUriTemplates } from "./uri-template.js";

async function formatTs(fileName: string, content: string): Promise<string> {
  try {
    const result = await format(fileName, content);
    return result.errors.length === 0 ? result.code : content;
  } catch {
    return content;
  }
}

export { $lib } from "./lib.js";

export async function $onEmit(context: EmitContext<TypespexEmitterOptions>): Promise<void> {
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
      httpOperations: getServerHttpOperations(service.operations),
    };
  });

  reportDuplicateOutputPaths(context, emissionPlans);
  for (const { ctx, httpOperations } of emissionPlans) {
    reportUnsupportedUriTemplates(ctx, httpOperations);
    reportRouteConflicts(ctx, httpOperations);
    reportIgnoredDecorators(ctx, httpOperations);
    reportRequestInputCollisions(ctx, httpOperations);
    reportUnsupportedResponseStatusContracts(ctx, httpOperations);
  }

  if (program.hasError()) return;

  // Render every service before writing anything. Some response diagnostics
  // are discovered while rendering, and an error must not leave partial output.
  const files = emissionPlans.flatMap(({ ctx, httpOperations, layout }) =>
    GENERATED_ARTIFACTS.map((artifact) => ({
      fileName: generatedArtifactFileName(artifact, layout.fileNames),
      outputDir: layout.outputDir,
      raw: artifact.emit(ctx, httpOperations),
    })),
  );

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

interface GeneratedArtifactDefinition {
  readonly artifact: string;
  readonly fileNameKey: keyof GeneratedFileNames;
  readonly emit: (ctx: EmitterCtx, httpOperations: HttpOperation[]) => string;
}

const GENERATED_ARTIFACTS: readonly GeneratedArtifactDefinition[] = [
  { artifact: "models", fileNameKey: "models", emit: (ctx) => emitModels(ctx) },
  { artifact: "server-hints", fileNameKey: "serverHints", emit: emitServerHints },
  {
    artifact: "server-operations",
    fileNameKey: "serverOperations",
    emit: emitServerOperations,
  },
  { artifact: "server", fileNameKey: "server", emit: emitServer },
  { artifact: "server-router", fileNameKey: "serverRouter", emit: emitServerRouter },
];

function reportDuplicateOutputPaths(
  context: EmitContext<TypespexEmitterOptions>,
  plans: readonly ServiceEmissionPlan[],
): void {
  const owners = new Map<string, string>();

  for (const { service, layout } of plans) {
    const serviceName = getNamespaceFullName(service.namespace) || "Service";
    for (const definition of GENERATED_ARTIFACTS) {
      const fileName = generatedArtifactFileName(definition, layout.fileNames);
      const path = resolvePath(context.emitterOutputDir, layout.outputDir, fileName);
      const artifact = `${serviceName}.${definition.artifact}`;
      const owner = owners.get(path);
      if (owner === undefined) {
        owners.set(path, artifact);
        continue;
      }

      $lib.reportDiagnostic(context.program, {
        code: "duplicate-output-path",
        format: { first: owner, second: artifact, path },
        target: service.namespace,
      });
    }
  }
}

function generatedArtifactFileName(
  definition: GeneratedArtifactDefinition,
  fileNames: GeneratedFileNames,
): string {
  return `${fileNames[definition.fileNameKey]}.ts`;
}

type ResolvedServiceOutput = "flat" | "prefix" | "directory";

interface ServiceLayout {
  readonly outputDir: string;
  readonly fileNames: GeneratedFileNames;
}

function resolveServiceOutput(options: TypespexEmitterOptions): ResolvedServiceOutput {
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
  const defaultFileNamePattern = serviceOutput === "prefix" ? "{service}.{file}" : "{file}";
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

function renderFileNames(pattern: string, tokens: NameTokens): GeneratedFileNames {
  return {
    models: renderNamePattern(pattern, tokens, DEFAULT_FILE_NAMES.models),
    serverHints: renderNamePattern(pattern, tokens, DEFAULT_FILE_NAMES.serverHints),
    serverOperations: renderNamePattern(pattern, tokens, DEFAULT_FILE_NAMES.serverOperations),
    server: renderNamePattern(pattern, tokens, DEFAULT_FILE_NAMES.server),
    serverRouter: renderNamePattern(pattern, tokens, DEFAULT_FILE_NAMES.serverRouter),
  };
}

function renderNamePattern(pattern: string, tokens: NameTokens, fileName = ""): string {
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
