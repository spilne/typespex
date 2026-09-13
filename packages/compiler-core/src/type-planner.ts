import {
  getDeprecated,
  getDoc,
  getSummary,
  isArrayModelType,
  resolveEncodedName,
  walkPropertiesInherited,
  type DiagnosticTarget,
  type EnumMember,
  type Model,
  type ModelProperty,
  type Program,
  type Scalar,
  type Type,
  type Union,
} from "@typespec/compiler";
import { JsonPlanner } from "./json-planner.js";
import { typescriptProperty, typescriptString } from "./naming.js";
import {
  COMPILER_PLAN_VERSION,
  type CompilerIssue,
  type JsonWirePlan,
  type TypeScriptModulePlan,
  type TypePlan,
} from "./plans.js";
import { ScalarPlanner } from "./scalar-planner.js";
import { hasUseSiteValueOverrides } from "./scalar-policy.js";
import { isNamedType, TypeRegistry, type NamedType } from "./type-registry.js";

export interface TypePlannerOptions {
  /** Names owned by the consuming protocol's generated declarations or imports. */
  readonly reservedTypeNames?: readonly string[];
  readonly datetimeMode?: "string" | "date" | "temporal";
  /** Use a canonical, lossless JSON representation independent of protocol-specific encodings. */
  readonly canonicalJsonWire?: boolean;
  /** Maps stream wrapper models to the item type exposed as a bounded JSON array. */
  readonly streamElementTypes?: ReadonlyMap<Model, Type>;
  /** Stream models discovered by an optional protocol library for direct exposure. */
  readonly nativeStreamTypes?: ReadonlySet<Model>;
  /** Protocol wrapper models replaced by their semantic payload types. */
  readonly typeSubstitutions?: ReadonlyMap<Model, Type>;
  readonly onIssue?: (issue: CompilerIssue) => void;
}

export interface TypeProjection {
  /** Stable suffix used for generated projected model declarations. */
  readonly key: string;
  /** Returns true when a model property participates in this protocol view. */
  readonly propertyFilter: (property: ModelProperty) => boolean;
}

export interface WirePlanOptions {
  readonly projection?: TypeProjection;
}

interface RegisteredProjection extends TypeProjection {
  readonly types: Set<Model | Union>;
  readonly names: Map<Model | Union, string>;
  readonly changes: Map<Type, boolean>;
}

/** Protocol-neutral TypeSpec type, JSON Schema, and wire-codec planner. */
export class TypePlanner {
  private readonly scalars: ScalarPlanner;
  private readonly types: TypeRegistry;
  private readonly json: JsonPlanner;
  private readonly projections = new Map<string, RegisteredProjection>();
  private readonly reportedIssues = new WeakMap<object, Set<string>>();
  private referencedTypeNames: Set<string> | undefined;

  constructor(
    readonly program: Program,
    readonly options: TypePlannerOptions = {},
  ) {
    this.scalars = new ScalarPlanner(program, {
      datetimeMode: options.datetimeMode,
      canonicalJsonWire: options.canonicalJsonWire,
      report: (code, message, target) => this.report(code, message, target),
    });
    this.types = new TypeRegistry(program, {
      reservedNames: [
        "Record",
        "ReadonlyArray",
        "File",
        "Uint8Array",
        ...(options.datetimeMode === "date" ? ["Date"] : []),
        ...(options.datetimeMode === "temporal" ? ["Temporal"] : []),
        ...(options.reservedTypeNames ?? []),
      ],
      streamElementTypes: options.streamElementTypes,
      nativeStreamTypes: options.nativeStreamTypes,
      typeSubstitutions: options.typeSubstitutions,
      report: (code, message, target) => this.report(code, message, target),
    });
    this.json = new JsonPlanner(program, this.types, this.scalars, (code, message, target) =>
      this.report(code, message, target),
    );
  }

  /** Collect every declaration reachable from the supplied roots and assign deterministic names. */
  prepare(rootTypes: readonly Type[]): void {
    if (this.types.prepare(rootTypes)) {
      this.json.invalidateTransformCache();
    }
  }

  get declarations(): readonly NamedType[] {
    return this.types.declarations;
  }

  getGeneratedName(type: NamedType): string {
    return this.types.getName(type);
  }

  getGeneratedWireName(type: NamedType): string {
    const semanticName = this.types.getName(type);
    if (!this.typeRequiresWireTransform(type)) return semanticName;
    return this.types.getWireName(type);
  }

  typeToTs(type: Type): string {
    const substituted = this.types.substitute(type);
    if (substituted !== type) return this.typeToTs(substituted);
    switch (type.kind) {
      case "Model":
        if (this.types.isFile(type)) return "File";
        if (this.types.isStream(type)) {
          const element = this.types.streamElement(type);
          return element ? `readonly ${this.typeToTs(element)}[]` : "never";
        }
        if (this.types.isUserDefined(type)) {
          return this.typeReference(this.getGeneratedName(type));
        }
        return this.modelExpressionToTs(type);
      case "Scalar":
        if (this.types.isUserDefined(type)) {
          return this.typeReference(this.getGeneratedName(type));
        }
        return this.scalars.semanticType(type);
      case "Enum":
        if (this.types.isUserDefined(type)) {
          return this.typeReference(this.getGeneratedName(type));
        }
        return (
          [...type.members.values()].map((member) => this.enumMemberToTs(member)).join(" | ") ||
          "never"
        );
      case "EnumMember":
        return this.enumMemberToTs(type);
      case "Union":
        if (this.types.isUserDefined(type)) {
          return this.typeReference(this.getGeneratedName(type));
        }
        return (
          this.unionVariants(type)
            .map((variant) => this.typeToTs(variant))
            .join(" | ") || "never"
        );
      case "UnionVariant":
      case "ModelProperty":
        return this.typeToTs(type.type);
      case "Tuple":
        return `readonly [${type.values.map((value) => this.typeToTs(value)).join(", ")}]`;
      case "String":
        return typescriptString(type.value);
      case "StringTemplate":
        return type.stringValue === undefined ? "string" : typescriptString(type.stringValue);
      case "Number":
        if (type.numericValue.asNumber() !== null) return type.valueAsString;
        return type.numericValue.asBigInt() === null
          ? typescriptString(type.numericValue.toString())
          : `${type.numericValue.asBigInt()!.toString()}n`;
      case "Boolean":
        return String(type.value);
      case "Intrinsic":
        switch (type.name) {
          case "null":
            return "null";
          case "void":
            return "void";
          case "never":
            return "never";
          default:
            return "unknown";
        }
      default:
        return "unknown";
    }
  }

  createWirePlan(type: Type | readonly Type[], options: WirePlanOptions = {}): JsonWirePlan {
    const types = Array.isArray(type) ? type : [type];
    this.prepare(types);
    const projection = options.projection
      ? this.getOrCreateProjection(options.projection)
      : undefined;
    if (projection) {
      for (const item of types) this.collectProjectionTypes(item, projection);
    }
    const json = this.json.createPlan(types, projection?.propertyFilter);
    const referencedTypes = new Set<string>();
    const [semanticType, wireType] = this.withReferencedTypes(referencedTypes, () => [
      types
        .map((item) =>
          projection ? this.projectedTypeToTs(item, projection) : this.typeToTs(item),
        )
        .join(" | "),
      types
        .map((item) =>
          projection ? this.projectedWireTypeToTs(item, projection) : this.wireTypeToTs(item),
        )
        .join(" | "),
    ]);
    return {
      version: COMPILER_PLAN_VERSION,
      ...json,
      semanticType,
      wireType,
      referencedTypes: [...referencedTypes].sort(),
    };
  }

  /** Every type exported by {@link createModelModulePlan}, including protocol visibility projections. */
  get emittedTypeNames(): readonly string[] {
    const names: string[] = [];
    for (const type of this.types.declarations) {
      const semanticName = this.getGeneratedName(type);
      const wireName = this.getGeneratedWireName(type);
      names.push(semanticName);
      if (wireName !== semanticName) names.push(wireName);
    }
    for (const projection of this.projections.values()) {
      for (const type of projection.types) {
        const semanticName = this.getProjectionTypeName(type, projection);
        const wireName = this.getProjectedWireTypeName(type, projection);
        names.push(semanticName);
        if (wireName !== semanticName) names.push(wireName);
      }
    }
    return names;
  }

  /** Data-only type index consumed by protocol emitter plans. */
  createTypePlans(): readonly TypePlan[] {
    return [
      ...this.types.declarations.map((type) => ({
        version: COMPILER_PLAN_VERSION,
        key: this.getGeneratedName(type),
        name: this.getGeneratedName(type),
        semanticType: this.getGeneratedName(type),
        wireType: this.getGeneratedWireName(type),
      })),
      ...[...this.projections.values()].flatMap((projection) =>
        [...projection.types].map((type) => {
          const name = this.getProjectionTypeName(type, projection);
          return {
            version: COMPILER_PLAN_VERSION,
            key: `${projection.key}:${name}`,
            name,
            semanticType: name,
            wireType: this.getProjectedWireTypeName(type, projection),
          };
        }),
      ),
    ];
  }

  createModelModulePlan(): TypeScriptModulePlan {
    const declarations = [
      ...this.types.declarations.flatMap((type) => [
        this.emitNamedType(type),
        this.emitNamedWireType(type),
      ]),
      ...[...this.projections.values()].flatMap((projection) =>
        [...projection.types].flatMap((type) => [
          this.emitProjectedNamedType(type, projection),
          this.emitProjectedNamedWireType(type, projection),
        ]),
      ),
    ].filter((declaration): declaration is string => declaration !== undefined);
    return {
      banner: "// Generated by TypeSpex. Do not edit.",
      imports:
        this.options.datetimeMode === "temporal"
          ? ['import type { Temporal } from "@js-temporal/polyfill";']
          : [],
      declarations,
    };
  }

  /** @deprecated Render {@link createModelModulePlan} with {@link renderTypeScriptModule}. */
  emitModels(): string {
    return renderTypeScriptModule(this.createModelModulePlan());
  }

  private emitProjectedNamedType(type: Model | Union, projection: RegisteredProjection): string {
    const documentation = this.emitDocumentation(type);
    const name = this.getProjectionTypeName(type, projection);
    if (type.kind === "Union") {
      return `${documentation}export type ${name} = ${
        this.unionVariants(type)
          .map((variant) => this.projectedTypeToTs(variant, projection))
          .join(" | ") || "never"
      };`;
    }
    if (isArrayModelType(this.program, type)) {
      return `${documentation}export type ${name} = ReadonlyArray<${this.projectedTypeToTs(type.indexer.value, projection)}>;`;
    }
    const properties = [...walkPropertiesInherited(type)]
      .filter(projection.propertyFilter)
      .map((property) => this.emitProjectedModelProperty(property, projection));
    const indexer = this.modelIndexSignature(type, projection);
    if (indexer) properties.push(indexer);
    return `${documentation}export interface ${name} {\n${properties.map((property) => `  ${property};`).join("\n")}\n}`;
  }

  private emitProjectedNamedWireType(
    type: Model | Union,
    projection: RegisteredProjection,
  ): string | undefined {
    if (!this.typeRequiresWireTransform(type, projection)) return undefined;
    const name = this.getProjectedWireTypeName(type, projection);
    if (type.kind === "Union") {
      return `export type ${name} = ${
        this.unionVariants(type)
          .map((variant) => this.projectedWireTypeToTs(variant, projection))
          .join(" | ") || "never"
      };`;
    }
    if (isArrayModelType(this.program, type)) {
      return `export type ${name} = ReadonlyArray<${this.projectedWireTypeToTs(type.indexer.value, projection)}>;`;
    }
    const properties = [...walkPropertiesInherited(type)]
      .filter(projection.propertyFilter)
      .map((property) => {
        const optional = property.optional || property.defaultValue !== undefined ? "?" : "";
        const wireName = resolveEncodedName(this.program, property, "application/json");
        return `${typescriptProperty(wireName)}${optional}: ${this.projectedWireTypeToTs(property.type, projection, property)}`;
      });
    const indexer = this.modelIndexSignature(type, projection, true);
    if (indexer) properties.push(indexer);
    return `export interface ${name} {\n${properties.map((property) => `  ${property};`).join("\n")}\n}`;
  }

  private emitProjectedModelProperty(
    property: ModelProperty,
    projection: RegisteredProjection,
  ): string {
    const doc = this.emitDocumentation(property, "  ");
    const optional = property.optional || property.defaultValue !== undefined ? "?" : "";
    return `${doc}${typescriptProperty(property.name)}${optional}: ${this.projectedTypeToTs(property.type, projection)}`;
  }

  private emitNamedType(type: NamedType): string {
    const documentation = this.emitDocumentation(type);
    const name = this.getGeneratedName(type);
    switch (type.kind) {
      case "Model": {
        if (isArrayModelType(this.program, type)) {
          return `${documentation}export type ${name} = ReadonlyArray<${this.typeToTs(type.indexer.value)}>;`;
        }
        const properties = [...walkPropertiesInherited(type)].map((property) =>
          this.emitModelProperty(property),
        );
        const indexer = this.modelIndexSignature(type);
        if (indexer) properties.push(indexer);
        return `${documentation}export interface ${name} {\n${properties.map((property) => `  ${property};`).join("\n")}\n}`;
      }
      case "Scalar":
        return `${documentation}export type ${name} = ${this.scalars.semanticType(type)};`;
      case "Enum":
        return `${documentation}export type ${name} = ${
          [...type.members.values()].map((member) => this.enumMemberToTs(member)).join(" | ") ||
          "never"
        };`;
      case "Union":
        return `${documentation}export type ${name} = ${
          this.unionVariants(type)
            .map((variant) => this.typeToTs(variant))
            .join(" | ") || "never"
        };`;
    }
  }

  private emitNamedWireType(type: NamedType): string | undefined {
    if (!this.typeRequiresWireTransform(type)) return undefined;
    const name = this.getGeneratedWireName(type);
    switch (type.kind) {
      case "Model": {
        if (isArrayModelType(this.program, type)) {
          return `export type ${name} = ReadonlyArray<${this.wireTypeToTs(type.indexer.value)}>;`;
        }
        const properties = [...walkPropertiesInherited(type)].map((property) => {
          const optional = property.optional || property.defaultValue !== undefined ? "?" : "";
          const wireName = resolveEncodedName(this.program, property, "application/json");
          return `${typescriptProperty(wireName)}${optional}: ${this.wireTypeToTs(property.type, property)}`;
        });
        const indexer = this.modelIndexSignature(type, undefined, true);
        if (indexer) properties.push(indexer);
        return `export interface ${name} {\n${properties.map((property) => `  ${property};`).join("\n")}\n}`;
      }
      case "Scalar":
        return `export type ${name} = ${this.scalars.wireType(type, type)};`;
      case "Enum":
        return `export type ${name} = ${
          [...type.members.values()].map((member) => this.enumMemberToTs(member)).join(" | ") ||
          "never"
        };`;
      case "Union":
        return `export type ${name} = ${
          this.unionVariants(type)
            .map((variant) => this.wireTypeToTs(variant))
            .join(" | ") || "never"
        };`;
    }
  }

  private emitModelProperty(property: ModelProperty): string {
    const doc = this.emitDocumentation(property, "  ");
    const optional = property.optional || property.defaultValue !== undefined ? "?" : "";
    return `${doc}${typescriptProperty(property.name)}${optional}: ${this.typeToTs(property.type)}`;
  }

  private emitDocumentation(target: Type, indent = ""): string {
    const summary = getSummary(this.program, target);
    const doc = getDoc(this.program, target);
    const deprecated = getDeprecated(this.program, target);
    const lines = [
      summary,
      doc && doc !== summary ? doc : undefined,
      deprecated ? `@deprecated ${deprecated}` : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .flatMap((line) => line.split("\n"));
    if (lines.length === 0) return "";
    return `${indent}/**\n${lines.map((line) => `${indent} * ${line.replaceAll("*/", "*\\/")}`).join("\n")}\n${indent} */\n${indent}`;
  }

  private modelExpressionToTs(model: Model): string {
    if (isArrayModelType(this.program, model)) {
      return `ReadonlyArray<${this.typeToTs(model.indexer.value)}>`;
    }
    const properties = [...walkPropertiesInherited(model)].map((property) => {
      const optional = property.optional || property.defaultValue !== undefined ? "?" : "";
      return `${typescriptProperty(property.name)}${optional}: ${this.typeToTs(property.type)}`;
    });
    const indexer = this.modelIndexSignature(model);
    if (indexer) properties.push(indexer);
    return properties.length > 0 ? `{ ${properties.join("; ")} }` : "Record<string, never>";
  }

  private getOrCreateProjection(projection: TypeProjection): RegisteredProjection {
    const existing = this.projections.get(projection.key);
    if (existing) return existing;
    const registered: RegisteredProjection = {
      ...projection,
      types: new Set(),
      names: new Map(),
      changes: new Map(),
    };
    this.projections.set(projection.key, registered);
    return registered;
  }

  private collectProjectionTypes(type: Type, projection: RegisteredProjection): void {
    const substituted = this.types.substitute(type);
    if (substituted !== type) {
      this.collectProjectionTypes(substituted, projection);
      return;
    }
    switch (type.kind) {
      case "Model":
        if (this.types.isFile(type)) return;
        if (this.types.isStream(type)) {
          const element = this.types.streamElement(type);
          if (element) this.collectProjectionTypes(element, projection);
          return;
        }
        if (this.types.isUserDefined(type)) {
          if (!this.projectionChangesType(type, projection)) return;
          if (projection.types.has(type)) return;
          projection.types.add(type);
          this.getProjectionTypeName(type, projection);
        }
        if (isArrayModelType(this.program, type)) {
          this.collectProjectionTypes(type.indexer.value, projection);
          return;
        }
        for (const property of walkPropertiesInherited(type)) {
          if (projection.propertyFilter(property)) {
            this.collectProjectionTypes(property.type, projection);
          }
        }
        const additional = this.types.indexer(type)?.value;
        if (additional) this.collectProjectionTypes(additional, projection);
        return;
      case "Union":
        if (this.types.isUserDefined(type)) {
          if (!this.projectionChangesType(type, projection)) return;
          if (projection.types.has(type)) return;
          projection.types.add(type);
          this.getProjectionTypeName(type, projection);
        }
        for (const variant of this.unionVariants(type)) {
          this.collectProjectionTypes(variant, projection);
        }
        return;
      case "UnionVariant":
      case "ModelProperty":
        this.collectProjectionTypes(type.type, projection);
        return;
      case "Tuple":
        for (const item of type.values) this.collectProjectionTypes(item, projection);
        return;
      default:
        return;
    }
  }

  private projectionChangesType(type: Type, projection: RegisteredProjection): boolean {
    const cached = projection.changes.get(type);
    if (cached !== undefined) return cached;
    const pending = [type];
    const visited = new Set<Type>();
    const parents = new Map<Type, Set<Type>>();
    const changed = new Set<Type>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const known = projection.changes.get(current);
      if (known !== undefined) {
        if (known) changed.add(current);
        continue;
      }
      const children: Type[] = [];
      const substituted = this.types.substitute(current);
      if (substituted !== current) {
        children.push(substituted);
      } else {
        switch (current.kind) {
          case "Model": {
            if (this.types.isFile(current)) break;
            if (this.types.isStream(current)) {
              const element = this.types.streamElement(current);
              if (element) children.push(element);
              break;
            }
            if (isArrayModelType(this.program, current)) {
              children.push(current.indexer.value);
              break;
            }
            for (const property of walkPropertiesInherited(current)) {
              if (projection.propertyFilter(property)) children.push(property.type);
              else changed.add(current);
            }
            const additional = this.types.indexer(current)?.value;
            if (additional) children.push(additional);
            break;
          }
          case "Union":
            children.push(...this.unionVariants(current));
            break;
          case "UnionVariant":
          case "ModelProperty":
            children.push(current.type);
            break;
          case "Tuple":
            children.push(...current.values);
            break;
        }
      }
      for (const child of children) {
        const dependents = parents.get(child) ?? new Set<Type>();
        dependents.add(current);
        parents.set(child, dependents);
        pending.push(child);
      }
    }
    // Propagate changed leaves back through cycles before caching any false
    // result. Each declaration and edge is examined a bounded number of times.
    pending.push(...changed);
    while (pending.length > 0) {
      for (const parent of parents.get(pending.pop()!) ?? []) {
        if (changed.has(parent)) continue;
        changed.add(parent);
        pending.push(parent);
      }
    }
    for (const current of visited) projection.changes.set(current, changed.has(current));
    return changed.has(type);
  }

  private getProjectionTypeName(type: Model | Union, projection: RegisteredProjection): string {
    const existing = projection.names.get(type);
    if (existing) return existing;
    const name = this.types.reserveProjectionName(type, projection.key);
    projection.names.set(type, name);
    return name;
  }

  private getProjectedWireTypeName(type: Model | Union, projection: RegisteredProjection): string {
    const semanticName = this.getProjectionTypeName(type, projection);
    return this.typeRequiresWireTransform(type, projection) ? `${semanticName}Wire` : semanticName;
  }

  private projectedTypeToTs(type: Type, projection: RegisteredProjection): string {
    const substituted = this.types.substitute(type);
    if (substituted !== type) return this.projectedTypeToTs(substituted, projection);
    switch (type.kind) {
      case "Model":
        if (this.types.isFile(type)) return "File";
        if (this.types.isStream(type)) {
          const element = this.types.streamElement(type);
          return element ? `readonly ${this.projectedTypeToTs(element, projection)}[]` : "never";
        }
        if (this.types.isUserDefined(type)) {
          if (!this.projectionChangesType(type, projection)) return this.typeToTs(type);
          this.collectProjectionTypes(type, projection);
          return this.typeReference(this.getProjectionTypeName(type, projection));
        }
        if (isArrayModelType(this.program, type)) {
          return `ReadonlyArray<${this.projectedTypeToTs(type.indexer.value, projection)}>`;
        }
        return this.projectedModelExpressionToTs(type, projection);
      case "Union":
        if (this.types.isUserDefined(type)) {
          if (!this.projectionChangesType(type, projection)) return this.typeToTs(type);
          this.collectProjectionTypes(type, projection);
          return this.typeReference(this.getProjectionTypeName(type, projection));
        }
        return (
          this.unionVariants(type)
            .map((variant) => this.projectedTypeToTs(variant, projection))
            .join(" | ") || "never"
        );
      case "UnionVariant":
      case "ModelProperty":
        return this.projectedTypeToTs(type.type, projection);
      case "Tuple":
        return `readonly [${type.values
          .map((item) => this.projectedTypeToTs(item, projection))
          .join(", ")}]`;
      default:
        return this.typeToTs(type);
    }
  }

  private wireTypeToTs(type: Type, encodingTarget?: ModelProperty | Scalar): string {
    const substituted = this.types.substitute(type);
    if (substituted !== type) return this.wireTypeToTs(substituted, encodingTarget);
    const useSiteScalarEncoding = hasUseSiteValueOverrides(this.program, type, encodingTarget);
    if (
      !useSiteScalarEncoding &&
      isNamedType(type) &&
      this.types.isUserDefined(type) &&
      !(type.kind === "Model" && (this.types.isFile(type) || this.types.isStream(type)))
    ) {
      return this.typeReference(this.getGeneratedWireName(type));
    }
    switch (type.kind) {
      case "Model":
        if (this.types.isFile(type)) {
          return `{ name: string; mediaType?: string; data: string }`;
        }
        if (this.types.isStream(type)) {
          const element = this.types.streamElement(type);
          return element ? `readonly ${this.wireTypeToTs(element)}[]` : "never";
        }
        if (isArrayModelType(this.program, type)) {
          return `ReadonlyArray<${this.wireTypeToTs(type.indexer.value)}>`;
        }
        return this.wireModelExpressionToTs(type);
      case "Scalar":
        return this.scalars.wireType(type, encodingTarget ?? type);
      case "Enum":
        return (
          [...type.members.values()].map((member) => this.enumMemberToTs(member)).join(" | ") ||
          "never"
        );
      case "EnumMember":
        return this.enumMemberToTs(type);
      case "Union":
        return (
          this.unionVariants(type)
            .map((variant) => this.wireTypeToTs(variant, encodingTarget))
            .join(" | ") || "never"
        );
      case "UnionVariant":
        return this.wireTypeToTs(type.type);
      case "ModelProperty":
        return this.wireTypeToTs(type.type, type);
      case "Tuple":
        return `readonly [${type.values.map((value) => this.wireTypeToTs(value)).join(", ")}]`;
      case "String":
        return typescriptString(type.value);
      case "StringTemplate":
        return type.stringValue === undefined ? "string" : typescriptString(type.stringValue);
      case "Number":
        return type.numericValue.asNumber() === null
          ? typescriptString(type.numericValue.toString())
          : type.valueAsString;
      case "Boolean":
        return String(type.value);
      case "Intrinsic":
        if (type.name === "null") return "null";
        if (type.name === "never") return "never";
        if (type.name === "void") return "void";
        return "unknown";
      default:
        return "unknown";
    }
  }

  private projectedWireTypeToTs(
    type: Type,
    projection: RegisteredProjection,
    encodingTarget?: ModelProperty | Scalar,
  ): string {
    const substituted = this.types.substitute(type);
    if (substituted !== type) {
      return this.projectedWireTypeToTs(substituted, projection, encodingTarget);
    }
    if (type.kind === "Model") {
      if (this.types.isFile(type)) return `{ name: string; mediaType?: string; data: string }`;
      if (this.types.isStream(type)) {
        const element = this.types.streamElement(type);
        return element ? `readonly ${this.projectedWireTypeToTs(element, projection)}[]` : "never";
      }
      if (this.types.isUserDefined(type)) {
        if (!this.projectionChangesType(type, projection)) {
          return this.typeReference(this.getGeneratedWireName(type));
        }
        this.collectProjectionTypes(type, projection);
        return this.typeReference(this.getProjectedWireTypeName(type, projection));
      }
      if (isArrayModelType(this.program, type)) {
        return `ReadonlyArray<${this.projectedWireTypeToTs(type.indexer.value, projection)}>`;
      }
      return this.projectedWireModelExpressionToTs(type, projection);
    }
    if (
      type.kind === "Union" &&
      this.types.isUserDefined(type) &&
      !hasUseSiteValueOverrides(this.program, type, encodingTarget)
    ) {
      if (!this.projectionChangesType(type, projection)) {
        return this.typeReference(this.getGeneratedWireName(type));
      }
      this.collectProjectionTypes(type, projection);
      return this.typeReference(this.getProjectedWireTypeName(type, projection));
    }
    if (type.kind === "Union") {
      return (
        this.unionVariants(type)
          .map((variant) => this.projectedWireTypeToTs(variant, projection, encodingTarget))
          .join(" | ") || "never"
      );
    }
    if (type.kind === "UnionVariant") {
      return this.projectedWireTypeToTs(type.type, projection);
    }
    if (type.kind === "ModelProperty") {
      return this.projectedWireTypeToTs(type.type, projection, type);
    }
    if (type.kind === "Tuple") {
      return `readonly [${type.values
        .map((item) => this.projectedWireTypeToTs(item, projection))
        .join(", ")}]`;
    }
    return this.wireTypeToTs(type, encodingTarget);
  }

  private wireModelExpressionToTs(model: Model): string {
    const properties = [...walkPropertiesInherited(model)].map((property) => {
      const optional = property.optional || property.defaultValue !== undefined ? "?" : "";
      const wireName = resolveEncodedName(this.program, property, "application/json");
      return `${typescriptProperty(wireName)}${optional}: ${this.wireTypeToTs(property.type, property)}`;
    });
    const indexer = this.modelIndexSignature(model, undefined, true);
    if (indexer) properties.push(indexer);
    return properties.length > 0 ? `{ ${properties.join("; ")} }` : "Record<string, never>";
  }

  private projectedWireModelExpressionToTs(model: Model, projection: RegisteredProjection): string {
    const properties = [...walkPropertiesInherited(model)]
      .filter(projection.propertyFilter)
      .map((property) => {
        const optional = property.optional || property.defaultValue !== undefined ? "?" : "";
        const wireName = resolveEncodedName(this.program, property, "application/json");
        return `${typescriptProperty(wireName)}${optional}: ${this.projectedWireTypeToTs(property.type, projection, property)}`;
      });
    const indexer = this.modelIndexSignature(model, projection, true);
    if (indexer) properties.push(indexer);
    return properties.length > 0 ? `{ ${properties.join("; ")} }` : "Record<string, never>";
  }

  private projectedModelExpressionToTs(model: Model, projection: RegisteredProjection): string {
    const properties = [...walkPropertiesInherited(model)]
      .filter(projection.propertyFilter)
      .map((property) => {
        const optional = property.optional || property.defaultValue !== undefined ? "?" : "";
        return `${typescriptProperty(property.name)}${optional}: ${this.projectedTypeToTs(property.type, projection)}`;
      });
    const indexer = this.modelIndexSignature(model, projection);
    if (indexer) properties.push(indexer);
    return properties.length > 0 ? `{ ${properties.join("; ")} }` : "Record<string, never>";
  }

  private modelIndexSignature(
    model: Model,
    projection?: RegisteredProjection,
    wire = false,
  ): string | undefined {
    const additional = this.types.indexer(model)?.value;
    if (!additional || (additional.kind === "Intrinsic" && additional.name === "never")) {
      return undefined;
    }
    const render = (type: Type, property?: ModelProperty): string =>
      projection
        ? wire
          ? this.projectedWireTypeToTs(type, projection, property)
          : this.projectedTypeToTs(type, projection)
        : wire
          ? this.wireTypeToTs(type, property)
          : this.typeToTs(type);
    // TypeScript index signatures cover declared keys too. Widen just the type
    // surface; schemas and codecs still constrain additional values separately.
    const values = new Set([render(additional)]);
    for (const property of walkPropertiesInherited(model)) {
      if (projection && !projection.propertyFilter(property)) continue;
      values.add(render(property.type, property));
      if (property.optional || property.defaultValue !== undefined) values.add("undefined");
    }
    return `[key: string]: ${[...values].join(" | ")}`;
  }

  private typeRequiresWireTransform(type: NamedType, projection?: RegisteredProjection): boolean {
    return this.json.requiresTransform(type, projection?.propertyFilter);
  }

  private enumMemberValue(member: EnumMember): string | number {
    return member.value ?? member.name;
  }

  private enumMemberToTs(member: EnumMember): string {
    const value = this.enumMemberValue(member);
    return typeof value === "string" ? typescriptString(value) : String(value);
  }

  private unionVariants(union: Union): Type[] {
    return [...union.variants.values()].map((variant) => variant.type);
  }

  private withReferencedTypes<T>(references: Set<string>, render: () => T): T {
    const previous = this.referencedTypeNames;
    this.referencedTypeNames = references;
    try {
      return render();
    } finally {
      this.referencedTypeNames = previous;
    }
  }

  private typeReference(name: string): string {
    this.referencedTypeNames?.add(name);
    return name;
  }

  private report(code: CompilerIssue["code"], message: string, target: DiagnosticTarget): void {
    const key = `${code}:${message}`;
    const issues = this.reportedIssues.get(target) ?? new Set<string>();
    if (issues.has(key)) return;
    issues.add(key);
    this.reportedIssues.set(target, issues);
    this.options.onIssue?.({ code, message, target });
  }
}

export function renderTypeScriptModule(plan: TypeScriptModulePlan): string {
  let source = `${plan.banner}\n`;
  if (plan.imports.length > 0) source += `${plan.imports.join("\n")}\n\n`;
  if (plan.declarations.length > 0) source += `${plan.declarations.join("\n\n")}\n`;
  return source;
}

export function isVoidType(type: Type): boolean {
  return type.kind === "Intrinsic" && type.name === "void";
}
