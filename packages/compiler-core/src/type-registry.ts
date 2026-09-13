import {
  getNamespaceFullName,
  isArrayModelType,
  type DiagnosticTarget,
  type Enum,
  type Model,
  type Program,
  type Scalar,
  type Type,
  type Union,
} from "@typespec/compiler";
import { pascalCase, typescriptIdentifier } from "./naming.js";
import type { CompilerIssue } from "./plans.js";

export type NamedType = Model | Scalar | Enum | Union;

interface TypeRegistryOptions {
  readonly streamElementTypes?: ReadonlyMap<Model, Type>;
  readonly nativeStreamTypes?: ReadonlySet<Model>;
  readonly typeSubstitutions?: ReadonlyMap<Model, Type>;
  readonly report: (code: CompilerIssue["code"], message: string, target: DiagnosticTarget) => void;
}

/** Collects reachable declarations and owns their deterministic TypeScript names. */
export class TypeRegistry {
  private readonly namedTypes: NamedType[] = [];
  private readonly includedTypes = new Set<NamedType>();
  private readonly expandedTypes = new Set<NamedType>();
  private readonly semanticNames = new Map<NamedType, string>();
  private readonly wireNames = new Map<NamedType, string>();
  private readonly reservedNames = new Set<string>();
  private namesPrepared = false;

  constructor(
    private readonly program: Program,
    private readonly options: TypeRegistryOptions,
  ) {}

  /** Collect reachable declarations, returning whether the declaration set changed. */
  prepare(rootTypes: readonly Type[]): boolean {
    const previousCount = this.namedTypes.length;
    for (const type of rootTypes) this.visit(type);
    this.assignNames();
    return this.namedTypes.length !== previousCount;
  }

  get declarations(): readonly NamedType[] {
    this.ensureNamesPrepared();
    return this.namedTypes;
  }

  getName(type: NamedType): string {
    this.ensureNamesPrepared();
    const name = this.semanticNames.get(type);
    if (!name) throw new Error(`Type ${type.name || type.kind} was not prepared for generation.`);
    return name;
  }

  getWireName(type: NamedType): string {
    this.ensureNamesPrepared();
    const name = this.wireNames.get(type);
    if (!name) throw new Error(`Type ${type.name || type.kind} was not prepared for generation.`);
    return name;
  }

  reserveProjectionName(type: Model | Union, key: string): string {
    const baseName = typescriptIdentifier(
      `${this.getName(type)}${pascalCase(key)}`,
      "ProjectedType",
    );
    const occupied = new Set([
      ...this.semanticNames.values(),
      ...this.wireNames.values(),
      ...this.reservedNames,
    ]);
    let name = baseName;
    let suffix = 2;
    while (occupied.has(name) || occupied.has(`${name}Wire`)) {
      name = `${baseName}${suffix++}`;
    }
    this.reservedNames.add(name);
    this.reservedNames.add(`${name}Wire`);
    return name;
  }

  substitute(type: Type): Type {
    return type.kind === "Model" ? (this.options.typeSubstitutions?.get(type) ?? type) : type;
  }

  isUserDefined(type: NamedType): boolean {
    return Boolean(type.name) && !this.isTypeSpecNamespace(type.namespace);
  }

  isFile(model: Model): boolean {
    let current: Model | undefined = model;
    while (current) {
      const namespace = current.namespace ? getNamespaceFullName(current.namespace) : "";
      if (current.name === "File" && (namespace === "TypeSpec" || namespace === "TypeSpec.Http")) {
        return true;
      }
      current = current.baseModel;
    }
    return false;
  }

  isStream(model: Model): boolean {
    if (this.options.streamElementTypes?.has(model) || this.options.nativeStreamTypes?.has(model)) {
      return true;
    }
    let current: Model | undefined = model;
    while (current) {
      const namespace = current.namespace ? getNamespaceFullName(current.namespace) : "";
      if (
        current.name === "Stream" &&
        (namespace.includes("Streams") || namespace === "TypeSpec")
      ) {
        return true;
      }
      current = current.baseModel;
    }
    return false;
  }

  streamElement(model: Model): Type | undefined {
    return this.options.streamElementTypes?.get(model);
  }

  indexer(model: Model): Model["indexer"] | undefined {
    let current: Model | undefined = model;
    while (current) {
      if (current.indexer) return current.indexer;
      current = current.baseModel;
    }
    return undefined;
  }

  private visit(type: Type): void {
    const substituted = this.substitute(type);
    if (substituted !== type) {
      this.visit(substituted);
      return;
    }
    switch (type.kind) {
      case "Model": {
        if (this.isStream(type)) {
          const element = this.streamElement(type);
          if (element) {
            this.visit(element);
            return;
          }
          this.options.report(
            "unsupported-stream",
            "Streams cannot be represented by this JSON wire plan.",
            type,
          );
          return;
        }
        if (this.isFile(type)) return;
        if (this.isUserDefined(type)) this.add(type);
        if (this.expandedTypes.has(type)) return;
        this.expandedTypes.add(type);
        if (isArrayModelType(this.program, type)) {
          this.visit(type.indexer.value);
          return;
        }
        if (type.baseModel) this.visit(type.baseModel);
        for (const property of type.properties.values()) this.visit(property.type);
        const additional = this.indexer(type)?.value;
        if (additional) this.visit(additional);
        return;
      }
      case "Scalar":
        if (this.isUserDefined(type)) this.add(type);
        if (type.baseScalar) this.visit(type.baseScalar);
        return;
      case "Enum":
        if (this.isUserDefined(type)) this.add(type);
        return;
      case "Union":
        if (this.isUserDefined(type)) this.add(type);
        if (this.expandedTypes.has(type)) return;
        this.expandedTypes.add(type);
        for (const variant of type.variants.values()) this.visit(variant.type);
        return;
      case "UnionVariant":
      case "ModelProperty":
        this.visit(type.type);
        return;
      case "Tuple":
        for (const item of type.values) this.visit(item);
        return;
      default:
        return;
    }
  }

  private add(type: NamedType): void {
    if (this.includedTypes.has(type)) return;
    this.includedTypes.add(type);
    this.namedTypes.push(type);
    this.namesPrepared = false;
  }

  private assignNames(): void {
    if (this.namesPrepared) return;
    this.semanticNames.clear();
    this.wireNames.clear();
    const used = new Set(this.reservedNames);
    for (const type of this.namedTypes) {
      const base = typescriptIdentifier(pascalCase(type.name || type.kind), "Value");
      let candidate = base;
      if (used.has(candidate)) {
        const namespace = type.namespace ? getNamespaceFullName(type.namespace) : "";
        candidate = typescriptIdentifier(`${pascalCase(namespace)}${base}`, base);
      }
      let suffix = 2;
      const initial = candidate;
      while (used.has(candidate)) candidate = `${initial}${suffix++}`;
      used.add(candidate);
      this.semanticNames.set(type, candidate);
    }
    const usedNames = new Set(used);
    for (const type of this.namedTypes) {
      const semanticName = this.semanticNames.get(type)!;
      const base = `${semanticName}Wire`;
      let candidate = base;
      let suffix = 2;
      while (usedNames.has(candidate)) candidate = `${base}${suffix++}`;
      usedNames.add(candidate);
      this.wireNames.set(type, candidate);
    }
    this.namesPrepared = true;
  }

  private ensureNamesPrepared(): void {
    if (!this.namesPrepared) this.assignNames();
  }

  private isTypeSpecNamespace(namespace: NamedType["namespace"]): boolean {
    let current = namespace;
    while (current) {
      if (current.name === "TypeSpec") return true;
      current = current.namespace;
    }
    return false;
  }
}

export function isNamedType(type: Type): type is NamedType {
  return (
    type.kind === "Model" || type.kind === "Scalar" || type.kind === "Enum" || type.kind === "Union"
  );
}
