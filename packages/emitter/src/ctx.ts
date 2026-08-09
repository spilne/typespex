import type { Namespace, Program, Type } from "@typespec/compiler";
import type { HttpService } from "@typespec/http";
import type { TypespexEmitterOptions } from "./lib.js";
import { collectEmittedNamedTypes, getNamedTypeKey, type EmittedNamedType } from "./named-types.js";
import { getNamespaceFullName } from "./namespace-names.js";
import { tsIdentifier } from "./typescript-names.js";

export { getNamespaceFullName } from "./namespace-names.js";

/** Identifiers already claimed by generated modules or TypeScript globals they use. */
export const GENERATED_TYPE_RESERVED_NAMES: ReadonlySet<string> = new Set([
  "Array",
  "Ctx",
  "File",
  "Record",
  "Uint8Array",
  "Decoder",
  "ServerOperation",
  "Either",
  "createHints",
  "emptyHints",
  "ResponseEncoders",
  "JsonSerializers",
  "Decoders",
  "RequestDecoders",
  "Validators",
  "decodeRequestInput",
  "decodeRequestInputAndBody",
  "decodeBody",
  "ServerHints",
  "MatchedRequestContext",
  "OperationHandler",
]);

export interface GeneratedNameCandidate<T> {
  readonly value: T;
  readonly stableKey: string;
  readonly baseName: string;
  readonly qualifiedName: string;
  readonly fallbackName: string;
  /** Keep a legal TypeScript object-property name verbatim when unambiguous. */
  readonly preserveBaseName?: boolean;
}

export interface EmitterCtx {
  program: Program;
  service: HttpService;
  serviceName: string;
  options: TypespexEmitterOptions;
  fileNames: GeneratedFileNames;
  /** Track which named types have been emitted to avoid duplicates. */
  emittedModels: Set<Type>;
  /** Named declarations emitted for this service, including external dependencies. */
  namedTypes: readonly EmittedNamedType[];
  /** Generated export names keyed by the semantic identity of a named type. */
  typeNames: ReadonlyMap<string, string>;
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
  const serviceName = service.namespace.name || "Service";
  const namedTypes = collectEmittedNamedTypes(program, service);
  return {
    program,
    service,
    serviceName,
    options,
    fileNames,
    emittedModels: new Set(),
    namedTypes,
    typeNames: createTypeNames(service, serviceName, namedTypes),
  };
}

/**
 * Allocate stable TypeScript identifiers while preserving unambiguous leaf
 * names. Callers provide readable qualified and fallback forms for collisions.
 */
export function allocateGeneratedNames<T>(
  candidates: readonly GeneratedNameCandidate<T>[],
  reservedNames: ReadonlySet<string> = new Set(),
): Map<T, string> {
  const baseCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const base = candidate.preserveBaseName
      ? candidate.baseName
      : tsIdentifier(candidate.baseName, "Generated");
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }

  const allocated = new Map<T, string>();
  const used = new Set(reservedNames);
  const ordered = [...candidates].sort((a, b) => a.stableKey.localeCompare(b.stableKey));

  // Reserve unique names first so qualified collision names cannot rename them.
  for (const candidate of ordered) {
    const base = candidate.preserveBaseName
      ? candidate.baseName
      : tsIdentifier(candidate.baseName, "Generated");
    if (baseCounts.get(base) === 1 && !used.has(base)) {
      allocated.set(candidate.value, base);
      used.add(base);
    }
  }

  for (const candidate of ordered) {
    if (allocated.has(candidate.value)) continue;

    const qualified = tsIdentifier(candidate.qualifiedName, "Generated");
    const fallback = tsIdentifier(candidate.fallbackName, "Generated");
    let name = !used.has(qualified) ? qualified : fallback;
    let suffix = 2;
    while (used.has(name)) {
      name = `${fallback}_${suffix}`;
      suffix += 1;
    }

    allocated.set(candidate.value, name);
    used.add(name);
  }

  return allocated;
}

export function getGeneratedTypeName(
  ctx: EmitterCtx,
  type: EmittedNamedType,
  fallback: string,
): string {
  return ctx.typeNames.get(getNamedTypeKey(type)) ?? tsIdentifier(type.name, fallback);
}

export function hasGeneratedTypeNameCollision(ctx: EmitterCtx, type: EmittedNamedType): boolean {
  const generatedName = ctx.typeNames.get(getNamedTypeKey(type));
  return generatedName !== undefined && generatedName !== tsIdentifier(type.name, "Generated");
}

export function getRelativeNamespaceSegments(
  serviceNamespace: Namespace,
  namespace: Namespace | undefined,
): string[] {
  const segments: string[] = [];
  let current = namespace;
  while (current && current.name !== "" && current !== serviceNamespace) {
    segments.push(current.name);
    current = current.namespace;
  }
  return segments.reverse();
}

function createTypeNames(
  service: HttpService,
  serviceName: string,
  declarations: readonly EmittedNamedType[],
): ReadonlyMap<string, string> {
  const names = allocateGeneratedNames(
    declarations.map((type) => {
      const name = type.name!;
      const namespace = getRelativeNamespaceSegments(service.namespace, type.namespace);
      const qualifiedSegments = namespace.length > 0 ? [...namespace, name] : [type.kind, name];
      return {
        value: type,
        stableKey: getNamedTypeKey(type),
        baseName: name,
        qualifiedName: qualifiedSegments.join("_"),
        fallbackName: [serviceName, ...qualifiedSegments, type.kind].join("_"),
      };
    }),
    GENERATED_TYPE_RESERVED_NAMES,
  );

  return new Map(declarations.map((type) => [getNamedTypeKey(type), names.get(type)!]));
}
