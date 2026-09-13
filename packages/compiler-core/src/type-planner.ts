import {
  getDeprecated,
  getDoc,
  getEncode,
  getFormat,
  getMaxItems,
  getMaxLength,
  getMaxValueAsNumeric,
  getMaxValueExclusiveAsNumeric,
  getMinItems,
  getMinLength,
  getMinValueAsNumeric,
  getMinValueExclusiveAsNumeric,
  getPatternData,
  getSummary,
  isArrayModelType,
  resolveEncodedName,
  serializeValueAsJson,
  walkPropertiesInherited,
  type DiagnosticTarget,
  type Enum,
  type EnumMember,
  type Model,
  type ModelProperty,
  type Program,
  type Scalar,
  type Type,
  type Union,
  type Value,
} from "@typespec/compiler";
import type { ObjectPropertyCodecSpec, ValueCodecDocument, ValueCodecSpec } from "@typespex/codec";
import { typescriptProperty, typescriptString } from "./naming.js";
import {
  COMPILER_PLAN_VERSION,
  type CompilerIssue,
  type JsonSchema,
  type JsonWirePlan,
  type TypeScriptModulePlan,
  type TypePlan,
} from "./plans.js";
import { ScalarPlanner } from "./scalar-planner.js";
import { TypeRegistry, type NamedType } from "./type-registry.js";

export interface TypePlannerOptions {
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

type SchemaObject = Record<string, unknown>;

interface DocumentState {
  readonly schemaDefinitions: Record<string, JsonSchema>;
  readonly codecDefinitions: Record<string, ValueCodecSpec>;
  readonly buildingSchemas: Set<NamedType>;
  readonly buildingCodecs: Set<NamedType>;
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
  private readonly projections = new Map<string, RegisteredProjection>();
  private readonly wireTransformCache = new Map<NamedType, boolean>();
  private readonly projectedWireTransformCache = new Map<
    RegisteredProjection,
    Map<NamedType, boolean>
  >();
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
      streamElementTypes: options.streamElementTypes,
      nativeStreamTypes: options.nativeStreamTypes,
      typeSubstitutions: options.typeSubstitutions,
      report: (code, message, target) => this.report(code, message, target),
    });
  }

  /** Collect every declaration reachable from the supplied roots and assign deterministic names. */
  prepare(rootTypes: readonly Type[]): void {
    if (this.types.prepare(rootTypes)) {
      this.wireTransformCache.clear();
      this.projectedWireTransformCache.clear();
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
    const state: DocumentState = {
      schemaDefinitions: Object.create(null) as Record<string, JsonSchema>,
      codecDefinitions: Object.create(null) as Record<string, ValueCodecSpec>,
      buildingSchemas: new Set(),
      buildingCodecs: new Set(),
    };

    const rootSchema =
      types.length === 1
        ? this.schemaForType(types[0]!, state, undefined, false, projection?.propertyFilter)
        : {
            anyOf: types.map((item) =>
              this.schemaForType(item, state, undefined, false, projection?.propertyFilter),
            ),
          };
    const rootCodec =
      types.length === 1
        ? this.codecForType(types[0]!, state, undefined, false, projection?.propertyFilter)
        : ({
            kind: "union",
            variants: types.map((item) =>
              this.codecForType(item, state, undefined, false, projection?.propertyFilter),
            ),
          } satisfies ValueCodecSpec);
    const schema = withDocumentMetadata(rootSchema, state.schemaDefinitions);
    const codecDocument: ValueCodecDocument = {
      root: rootCodec,
      ...(Object.keys(state.codecDefinitions).length > 0
        ? { definitions: state.codecDefinitions }
        : {}),
    };
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
      schema,
      ...(codecDocumentRequiresTransform(codecDocument) ? { codec: codecDocument } : {}),
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
    const additional = this.types.indexer(type)?.value;
    if (additional) {
      const object = `{ ${properties.join("; ")} }`;
      return `${documentation}export type ${name} = ${object} & Record<string, ${this.projectedTypeToTs(additional, projection)}>;`;
    }
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
    const additional = this.types.indexer(type)?.value;
    if (additional) {
      const object = `{ ${properties.join("; ")} }`;
      return `export type ${name} = ${object} & Record<string, ${this.projectedWireTypeToTs(additional, projection)}>;`;
    }
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
        const additional = this.types.indexer(type)?.value;
        if (additional) {
          const object = `{ ${properties.join("; ")} }`;
          return `${documentation}export type ${name} = ${object} & Record<string, ${this.typeToTs(additional)}>;`;
        }
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
        const additional = this.types.indexer(type)?.value;
        if (additional) {
          const object = `{ ${properties.join("; ")} }`;
          return `export type ${name} = ${object} & Record<string, ${this.wireTypeToTs(additional)}>;`;
        }
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
    let expression =
      properties.length > 0 ? `{ ${properties.join("; ")} }` : "Record<string, never>";
    const additional = this.types.indexer(model)?.value;
    if (additional) {
      const indexer = `Record<string, ${this.typeToTs(additional)}>`;
      expression = properties.length > 0 ? `${expression} & ${indexer}` : indexer;
    }
    return expression;
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

  private projectionChangesType(
    type: Type,
    projection: RegisteredProjection,
    visiting = new Set<Type>(),
  ): boolean {
    const substituted = this.types.substitute(type);
    if (substituted !== type) {
      return this.projectionChangesType(substituted, projection, visiting);
    }
    const cached = projection.changes.get(type);
    if (cached !== undefined) return cached;
    if (visiting.has(type)) return false;
    visiting.add(type);
    let changed = false;
    switch (type.kind) {
      case "Model":
        if (this.types.isFile(type)) break;
        if (this.types.isStream(type)) {
          const element = this.types.streamElement(type);
          changed = element ? this.projectionChangesType(element, projection, visiting) : false;
          break;
        }
        if (isArrayModelType(this.program, type)) {
          changed = this.projectionChangesType(type.indexer.value, projection, visiting);
          break;
        }
        for (const property of walkPropertiesInherited(type)) {
          if (!projection.propertyFilter(property)) {
            changed = true;
            break;
          }
          if (this.projectionChangesType(property.type, projection, visiting)) {
            changed = true;
            break;
          }
        }
        const additional = this.types.indexer(type)?.value;
        if (!changed && additional) {
          changed = this.projectionChangesType(additional, projection, visiting);
        }
        break;
      case "Union":
        changed = this.unionVariants(type).some((variant) =>
          this.projectionChangesType(variant, projection, visiting),
        );
        break;
      case "UnionVariant":
      case "ModelProperty":
        changed = this.projectionChangesType(type.type, projection, visiting);
        break;
      case "Tuple":
        changed = type.values.some((item) =>
          this.projectionChangesType(item, projection, visiting),
        );
        break;
    }
    visiting.delete(type);
    projection.changes.set(type, changed);
    return changed;
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
    const useSiteScalarEncoding =
      type.kind === "Scalar" &&
      encodingTarget !== undefined &&
      encodingTarget !== type &&
      getEncode(this.program, encodingTarget) !== undefined;
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
            .map((variant) => this.wireTypeToTs(variant))
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
    if (type.kind === "Union" && this.types.isUserDefined(type)) {
      if (!this.projectionChangesType(type, projection)) {
        return this.typeReference(this.getGeneratedWireName(type));
      }
      this.collectProjectionTypes(type, projection);
      return this.typeReference(this.getProjectedWireTypeName(type, projection));
    }
    if (type.kind === "Union") {
      return (
        this.unionVariants(type)
          .map((variant) => this.projectedWireTypeToTs(variant, projection))
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
    let expression =
      properties.length > 0 ? `{ ${properties.join("; ")} }` : "Record<string, never>";
    const additional = this.types.indexer(model)?.value;
    if (additional) {
      const indexer = `Record<string, ${this.wireTypeToTs(additional)}>`;
      expression = properties.length > 0 ? `${expression} & ${indexer}` : indexer;
    }
    return expression;
  }

  private projectedWireModelExpressionToTs(model: Model, projection: RegisteredProjection): string {
    const properties = [...walkPropertiesInherited(model)]
      .filter(projection.propertyFilter)
      .map((property) => {
        const optional = property.optional || property.defaultValue !== undefined ? "?" : "";
        const wireName = resolveEncodedName(this.program, property, "application/json");
        return `${typescriptProperty(wireName)}${optional}: ${this.projectedWireTypeToTs(property.type, projection, property)}`;
      });
    let expression =
      properties.length > 0 ? `{ ${properties.join("; ")} }` : "Record<string, never>";
    const additional = this.types.indexer(model)?.value;
    if (additional) {
      const indexer = `Record<string, ${this.projectedWireTypeToTs(additional, projection)}>`;
      expression = properties.length > 0 ? `${expression} & ${indexer}` : indexer;
    }
    return expression;
  }

  private projectedModelExpressionToTs(model: Model, projection: RegisteredProjection): string {
    const properties = [...walkPropertiesInherited(model)]
      .filter(projection.propertyFilter)
      .map((property) => {
        const optional = property.optional || property.defaultValue !== undefined ? "?" : "";
        return `${typescriptProperty(property.name)}${optional}: ${this.projectedTypeToTs(property.type, projection)}`;
      });
    let expression =
      properties.length > 0 ? `{ ${properties.join("; ")} }` : "Record<string, never>";
    const additional = this.types.indexer(model)?.value;
    if (additional) {
      const indexer = `Record<string, ${this.projectedTypeToTs(additional, projection)}>`;
      expression = properties.length > 0 ? `${expression} & ${indexer}` : indexer;
    }
    return expression;
  }

  private schemaForType(
    type: Type,
    state: DocumentState,
    encodingTarget?: ModelProperty | Scalar,
    inlineNamed = false,
    propertyFilter?: (property: ModelProperty) => boolean,
  ): JsonSchema {
    const substituted = this.types.substitute(type);
    if (substituted !== type) {
      return this.schemaForType(substituted, state, encodingTarget, inlineNamed, propertyFilter);
    }
    const useSiteScalarEncoding =
      type.kind === "Scalar" &&
      encodingTarget !== undefined &&
      encodingTarget !== type &&
      getEncode(this.program, encodingTarget) !== undefined;
    const protocolModel =
      type.kind === "Model" && (this.types.isFile(type) || this.types.isStream(type));
    if (
      !inlineNamed &&
      !useSiteScalarEncoding &&
      !protocolModel &&
      isNamedType(type) &&
      this.types.isUserDefined(type)
    ) {
      this.ensureSchemaDefinition(type, state, propertyFilter);
      const reference = { $ref: `#/$defs/${this.getGeneratedName(type)}` };
      return encodingTarget ? this.applySchemaMetadata(reference, encodingTarget) : reference;
    }

    let schema: JsonSchema;
    switch (type.kind) {
      case "Model":
        schema = this.modelSchema(type, state, propertyFilter);
        break;
      case "Scalar":
        schema = this.scalars.schema(type, encodingTarget ?? type);
        break;
      case "Enum":
        schema = { enum: [...type.members.values()].map((member) => this.enumMemberValue(member)) };
        break;
      case "EnumMember":
        schema = { const: this.enumMemberValue(type) };
        break;
      case "Union":
        schema = {
          anyOf: this.unionVariants(type).map((variant) =>
            this.schemaForType(variant, state, undefined, false, propertyFilter),
          ),
        };
        break;
      case "UnionVariant":
      case "ModelProperty":
        schema = this.schemaForType(
          type.type,
          state,
          type.kind === "ModelProperty" ? type : undefined,
          false,
          propertyFilter,
        );
        break;
      case "Tuple":
        schema = {
          type: "array",
          prefixItems: type.values.map((value) =>
            this.schemaForType(value, state, undefined, false, propertyFilter),
          ),
          minItems: type.values.length,
          maxItems: type.values.length,
        };
        break;
      case "String":
        schema = { type: "string", const: type.value };
        break;
      case "StringTemplate":
        schema =
          type.stringValue === undefined
            ? { type: "string" }
            : { type: "string", const: type.stringValue };
        break;
      case "Number": {
        const number = type.numericValue.asNumber();
        schema =
          number === null
            ? { type: "string", const: type.numericValue.toString() }
            : { type: "number", const: number };
        break;
      }
      case "Boolean":
        schema = { type: "boolean", const: type.value };
        break;
      case "Intrinsic":
        if (type.name === "null") schema = { type: "null" };
        else if (type.name === "never") schema = false;
        else schema = {};
        break;
      default:
        this.report(
          "unsupported-type",
          `TypeSpec type kind ${type.kind} is not representable in JSON Schema.`,
          type,
        );
        schema = {};
        break;
    }
    return this.applySchemaMetadata(schema, encodingTarget ?? type);
  }

  private modelSchema(
    model: Model,
    state: DocumentState,
    propertyFilter?: (property: ModelProperty) => boolean,
  ): JsonSchema {
    if (this.types.isStream(model)) {
      const element = this.types.streamElement(model);
      if (element) {
        return {
          type: "array",
          items: this.schemaForType(element, state, undefined, false, propertyFilter),
        };
      }
      this.report(
        "unsupported-stream",
        "Streams cannot be represented by this JSON wire plan.",
        model,
      );
      return false;
    }
    if (this.types.isFile(model)) {
      return {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1 },
          mediaType: { type: "string" },
          data: { type: "string", contentEncoding: "base64" },
        },
        required: ["name", "data"],
        additionalProperties: false,
      };
    }
    if (isArrayModelType(this.program, model)) {
      return {
        type: "array",
        items: this.schemaForType(model.indexer.value, state, undefined, false, propertyFilter),
      };
    }

    const properties: Record<string, JsonSchema> = Object.create(null) as Record<
      string,
      JsonSchema
    >;
    const required: string[] = [];
    for (const property of walkPropertiesInherited(model)) {
      if (propertyFilter && !propertyFilter(property)) continue;
      const wireName = resolveEncodedName(this.program, property, "application/json");
      let propertySchema = this.schemaForType(
        property.type,
        state,
        property,
        false,
        propertyFilter,
      );
      const defaultValue = this.propertyDefaultValue(property);
      const description = getDoc(this.program, property) ?? getSummary(this.program, property);
      if (isSchemaObject(propertySchema)) {
        propertySchema = {
          ...propertySchema,
          ...(description ? { description } : {}),
          ...(defaultValue.present ? { default: defaultValue.value } : {}),
          ...(getDeprecated(this.program, property) ? { deprecated: true } : {}),
        };
      }
      properties[wireName] = propertySchema;
      if (!property.optional && !defaultValue.present) required.push(wireName);
    }
    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: this.types.indexer(model)?.value
        ? this.schemaForType(
            this.types.indexer(model)!.value,
            state,
            undefined,
            false,
            propertyFilter,
          )
        : false,
    };
  }

  private codecForType(
    type: Type,
    state: DocumentState,
    encodingTarget?: ModelProperty | Scalar,
    inlineNamed = false,
    propertyFilter?: (property: ModelProperty) => boolean,
  ): ValueCodecSpec {
    const substituted = this.types.substitute(type);
    if (substituted !== type) {
      return this.codecForType(substituted, state, encodingTarget, inlineNamed, propertyFilter);
    }
    const useSiteScalarEncoding =
      type.kind === "Scalar" &&
      encodingTarget !== undefined &&
      encodingTarget !== type &&
      getEncode(this.program, encodingTarget) !== undefined;
    const protocolModel =
      type.kind === "Model" && (this.types.isFile(type) || this.types.isStream(type));
    if (
      !inlineNamed &&
      !useSiteScalarEncoding &&
      !protocolModel &&
      isNamedType(type) &&
      this.types.isUserDefined(type)
    ) {
      this.ensureCodecDefinition(type, state, propertyFilter);
      return { kind: "ref", name: this.getGeneratedName(type) };
    }

    switch (type.kind) {
      case "Model":
        if (this.types.isFile(type)) return { kind: "file" };
        if (this.types.isStream(type)) {
          const element = this.types.streamElement(type);
          return element
            ? {
                kind: "array",
                item: this.codecForType(element, state, undefined, false, propertyFilter),
              }
            : { kind: "identity" };
        }
        if (isArrayModelType(this.program, type)) {
          return {
            kind: "array",
            item: this.codecForType(type.indexer.value, state, undefined, false, propertyFilter),
          };
        }
        return this.objectCodec(type, state, propertyFilter);
      case "Scalar":
        return this.scalars.codec(type, encodingTarget ?? type);
      case "Enum":
        return {
          kind: "union",
          variants: [...type.members.values()].map((member) => ({
            kind: "literal",
            value: this.enumMemberValue(member),
          })),
        };
      case "EnumMember":
        return { kind: "literal", value: this.enumMemberValue(type) };
      case "Union":
        return {
          kind: "union",
          variants: this.unionVariants(type).map((variant) =>
            this.codecForType(variant, state, undefined, false, propertyFilter),
          ),
        };
      case "UnionVariant":
      case "ModelProperty":
        return this.codecForType(
          type.type,
          state,
          type.kind === "ModelProperty" ? type : undefined,
          false,
          propertyFilter,
        );
      case "Tuple":
        return {
          kind: "tuple",
          items: type.values.map((item) =>
            this.codecForType(item, state, undefined, false, propertyFilter),
          ),
        };
      case "String":
        return { kind: "literal", value: type.value };
      case "StringTemplate":
        return type.stringValue === undefined
          ? { kind: "primitive", type: "string" }
          : { kind: "literal", value: type.stringValue };
      case "Number": {
        const value = type.numericValue.asNumber();
        if (value !== null) return { kind: "literal", value };
        const bigint = type.numericValue.asBigInt();
        return bigint === null
          ? { kind: "literal", value: type.numericValue.toString() }
          : { kind: "bigint-literal-string", value: bigint.toString() };
      }
      case "Boolean":
        return { kind: "literal", value: type.value };
      case "Intrinsic":
        return type.name === "null" ? { kind: "primitive", type: "null" } : { kind: "identity" };
      default:
        return { kind: "identity" };
    }
  }

  private objectCodec(
    model: Model,
    state: DocumentState,
    propertyFilter?: (property: ModelProperty) => boolean,
  ): ValueCodecSpec {
    const properties: Record<string, ObjectPropertyCodecSpec> = Object.create(null) as Record<
      string,
      ObjectPropertyCodecSpec
    >;
    for (const property of walkPropertiesInherited(model)) {
      if (propertyFilter && !propertyFilter(property)) continue;
      const defaultValue = this.propertyDefaultValue(property);
      properties[property.name] = {
        wireName: resolveEncodedName(this.program, property, "application/json"),
        codec: this.codecForType(property.type, state, property, false, propertyFilter),
        ...(property.optional || defaultValue.present ? { optional: true } : {}),
        ...(defaultValue.present ? { hasDefault: true, defaultValue: defaultValue.value } : {}),
      };
    }
    return {
      kind: "object",
      properties,
      ...(this.types.indexer(model)?.value
        ? {
            additionalProperties: this.codecForType(
              this.types.indexer(model)!.value,
              state,
              undefined,
              false,
              propertyFilter,
            ),
          }
        : {}),
    };
  }

  private typeRequiresWireTransform(type: NamedType, projection?: RegisteredProjection): boolean {
    const cache = projection
      ? (this.projectedWireTransformCache.get(projection) ?? new Map<NamedType, boolean>())
      : this.wireTransformCache;
    if (projection && !this.projectedWireTransformCache.has(projection)) {
      this.projectedWireTransformCache.set(projection, cache);
    }
    const cached = cache.get(type);
    if (cached !== undefined) return cached;
    const state: DocumentState = {
      schemaDefinitions: Object.create(null) as Record<string, JsonSchema>,
      codecDefinitions: Object.create(null) as Record<string, ValueCodecSpec>,
      buildingSchemas: new Set(),
      buildingCodecs: new Set(),
    };
    const document: ValueCodecDocument = {
      root: this.codecForType(type, state, undefined, true, projection?.propertyFilter),
      ...(Object.keys(state.codecDefinitions).length > 0
        ? { definitions: state.codecDefinitions }
        : {}),
    };
    const result = codecDocumentRequiresTransform(document);
    cache.set(type, result);
    return result;
  }

  private ensureSchemaDefinition(
    type: NamedType,
    state: DocumentState,
    propertyFilter?: (property: ModelProperty) => boolean,
  ): void {
    const name = this.getGeneratedName(type);
    if (Object.prototype.hasOwnProperty.call(state.schemaDefinitions, name)) return;
    if (state.buildingSchemas.has(type)) return;
    state.buildingSchemas.add(type);
    state.schemaDefinitions[name] = this.schemaForType(
      type,
      state,
      undefined,
      true,
      propertyFilter,
    );
    state.buildingSchemas.delete(type);
  }

  private ensureCodecDefinition(
    type: NamedType,
    state: DocumentState,
    propertyFilter?: (property: ModelProperty) => boolean,
  ): void {
    const name = this.getGeneratedName(type);
    if (Object.prototype.hasOwnProperty.call(state.codecDefinitions, name)) return;
    if (state.buildingCodecs.has(type)) return;
    state.buildingCodecs.add(type);
    // Install a placeholder before descending so direct recursive references resolve.
    state.codecDefinitions[name] = { kind: "identity" };
    state.codecDefinitions[name] = this.codecForType(type, state, undefined, true, propertyFilter);
    state.buildingCodecs.delete(type);
  }

  private applySchemaMetadata(schema: JsonSchema, target: Type): JsonSchema {
    if (!isSchemaObject(schema)) return schema;
    const additions: SchemaObject = {};
    const description = getDoc(this.program, target) ?? getSummary(this.program, target);
    const minLength = getMinLength(this.program, target);
    const maxLength = getMaxLength(this.program, target);
    const minItems = getMinItems(this.program, target);
    const maxItems = getMaxItems(this.program, target);
    const min = getMinValueAsNumeric(this.program, target)?.asNumber();
    const max = getMaxValueAsNumeric(this.program, target)?.asNumber();
    const minExclusive = getMinValueExclusiveAsNumeric(this.program, target)?.asNumber();
    const maxExclusive = getMaxValueExclusiveAsNumeric(this.program, target)?.asNumber();
    const pattern = getPatternData(this.program, target)?.pattern;
    const format = getFormat(this.program, target);
    if (description !== undefined) additions.description = description;
    if (getDeprecated(this.program, target) !== undefined) additions.deprecated = true;
    if (minLength !== undefined) additions.minLength = minLength;
    if (maxLength !== undefined) additions.maxLength = maxLength;
    if (minItems !== undefined) additions.minItems = minItems;
    if (maxItems !== undefined) additions.maxItems = maxItems;
    if (min !== undefined && min !== null) additions.minimum = min;
    if (max !== undefined && max !== null) additions.maximum = max;
    if (minExclusive !== undefined && minExclusive !== null)
      additions.exclusiveMinimum = minExclusive;
    if (maxExclusive !== undefined && maxExclusive !== null)
      additions.exclusiveMaximum = maxExclusive;
    if (pattern !== undefined) additions.pattern = pattern;
    if (format !== undefined) additions.format = format;
    return Object.keys(additions).length === 0 ? schema : { ...schema, ...additions };
  }

  private propertyDefaultValue(
    property: ModelProperty,
  ): { readonly present: false } | { readonly present: true; readonly value: unknown } {
    if (property.defaultValue === undefined) return { present: false };
    try {
      const value = this.valueToJson(property.defaultValue, property);
      if (value === undefined) {
        this.report(
          "unsupported-type",
          `Default value for ${this.propertyDisplayName(property)} cannot be represented on the JSON wire.`,
          property,
        );
        return { present: false };
      }
      return { present: true, value };
    } catch (error) {
      this.report(
        "unsupported-type",
        `Default value for ${this.propertyDisplayName(property)} cannot be represented on the JSON wire: ${error instanceof Error ? error.message : String(error)}`,
        property,
      );
      return { present: false };
    }
  }

  private valueToJson(value: Value, target: Type): unknown {
    const resolvedTarget = this.resolveDefaultValueTarget(value, target);
    switch (value.valueKind) {
      case "StringValue":
        return value.value;
      case "BooleanValue":
      case "NumericValue":
      case "ScalarValue": {
        const scalar = resolvedTarget.kind === "Scalar" ? resolvedTarget : value.scalar;
        const encodingTarget = target.kind === "ModelProperty" ? target : scalar;
        return this.scalars.defaultValueToJson(value, { scalar, encodingTarget });
      }
      case "NullValue":
        return null;
      case "EnumValue":
        return this.enumMemberValue(value.value);
      case "ArrayValue": {
        const itemTypes =
          resolvedTarget.kind === "Tuple"
            ? resolvedTarget.values
            : resolvedTarget.kind === "Model" && isArrayModelType(this.program, resolvedTarget)
              ? value.values.map(() => resolvedTarget.indexer.value)
              : [];
        return value.values.map((item, index) =>
          this.valueToJson(item, itemTypes[index] ?? item.type),
        );
      }
      case "ObjectValue": {
        if (resolvedTarget.kind !== "Model") {
          return serializeValueAsJson(this.program, value, resolvedTarget);
        }
        const definitions = new Map(
          [...walkPropertiesInherited(resolvedTarget)].map((property) => [property.name, property]),
        );
        const additional = this.types.indexer(resolvedTarget)?.value;
        return Object.fromEntries(
          [...value.properties.values()].map((property) => {
            const definition = definitions.get(property.name);
            return [
              definition
                ? resolveEncodedName(this.program, definition, "application/json")
                : property.name,
              this.valueToJson(property.value, definition ?? additional ?? property.value.type),
            ];
          }),
        );
      }
      default:
        return undefined;
    }
  }

  private resolveDefaultValueTarget(value: Value, target: Type): Type {
    const unwrapped =
      target.kind === "ModelProperty" || target.kind === "UnionVariant" ? target.type : target;
    if (unwrapped.kind === "Union") {
      const checker = this.program.checker as typeof this.program.checker & {
        isTypeAssignableTo?: (
          source: Type,
          target: Type,
          diagnosticTarget: Value,
        ) => readonly [boolean, readonly unknown[]];
      };
      const source = checker.getValueExactType(value) ?? value.type;
      for (const variant of unwrapped.variants.values()) {
        if (checker.isTypeAssignableTo?.(source, variant.type, value)[0]) {
          return this.resolveDefaultValueTarget(value, variant.type);
        }
      }
    }
    return unwrapped;
  }

  private propertyDisplayName(property: ModelProperty): string {
    const modelName = property.model?.name;
    return modelName ? `${modelName}.${property.name}` : property.name;
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

function isNamedType(type: Type): type is NamedType {
  return (
    type.kind === "Model" || type.kind === "Scalar" || type.kind === "Enum" || type.kind === "Union"
  );
}

function isSchemaObject(schema: JsonSchema): schema is SchemaObject {
  return typeof schema === "object" && schema !== null;
}

function withDocumentMetadata(
  root: JsonSchema,
  definitions: Readonly<Record<string, JsonSchema>>,
): JsonSchema {
  const metadata = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...(Object.keys(definitions).length > 0 ? { $defs: definitions } : {}),
  };
  return isSchemaObject(root) ? { ...metadata, ...root } : { ...metadata, allOf: [root] };
}

function codecDocumentRequiresTransform(document: ValueCodecDocument): boolean {
  const visiting = new Set<string>();
  const requiresTransform = (spec: ValueCodecSpec): boolean => {
    switch (spec.kind) {
      case "identity":
      case "primitive":
      case "literal":
      case "decimal-string":
        return false;
      case "date-time":
        return !(
          spec.representation === "string" ||
          (spec.representation === "date" && spec.format !== "date-time")
        );
      case "bigint-string":
      case "bigint-literal-string":
      case "bigint-number":
      case "number-string":
      case "boolean-string":
      case "bytes":
      case "file":
        return true;
      case "array":
        return requiresTransform(spec.item);
      case "tuple":
        return spec.items.some(requiresTransform);
      case "union":
        return spec.variants.some(requiresTransform);
      case "object":
        return (
          Object.entries(spec.properties).some(
            ([semanticName, property]) =>
              property.wireName !== semanticName ||
              property.hasDefault === true ||
              requiresTransform(property.codec),
          ) ||
          (spec.additionalProperties !== undefined &&
            spec.additionalProperties !== true &&
            requiresTransform(spec.additionalProperties))
        );
      case "ref": {
        if (visiting.has(spec.name)) return false;
        const target = document.definitions?.[spec.name];
        if (!target) return true;
        visiting.add(spec.name);
        const result = requiresTransform(target);
        visiting.delete(spec.name);
        return result;
      }
    }
  };
  return requiresTransform(document.root);
}
