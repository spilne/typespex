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
  getNamespaceFullName,
  getPatternData,
  getSummary,
  isArrayModelType,
  resolveEncodedName,
  walkPropertiesInherited,
  type DiagnosticTarget,
  type EncodeData,
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
import type {
  ObjectPropertyCodecSpec,
  ValueCodecDocument,
  ValueCodecSpec,
} from "@typespex/runtime/codec";
import {
  pascalCase,
  typescriptIdentifier,
  typescriptProperty,
  typescriptString,
} from "./naming.js";
import type { CodegenIssue, JsonSchema, JsonWirePlan } from "./plans.js";

export interface TypePlannerOptions {
  readonly datetimeMode?: "string" | "date" | "temporal";
  /** Keep MCP JSON safe and move declared protocol encodings into a separate wire plan. */
  readonly canonicalJsonWire?: boolean;
  /** Maps HTTP stream wrapper models to the item type exposed as a bounded MCP array. */
  readonly streamElementTypes?: ReadonlyMap<Model, Type>;
  /** Stream models discovered by an optional protocol library in native mode. */
  readonly nativeStreamTypes?: ReadonlySet<Model>;
  /** Protocol wrapper models replaced by their semantic payload types. */
  readonly typeSubstitutions?: ReadonlyMap<Model, Type>;
  readonly onIssue?: (issue: CodegenIssue) => void;
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

type NamedType = Model | Scalar | Enum | Union;
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
  private readonly namedTypes: NamedType[] = [];
  private readonly includedTypes = new Set<NamedType>();
  private readonly expandedTypes = new Set<NamedType>();
  private readonly generatedNames = new Map<NamedType, string>();
  private readonly projections = new Map<string, RegisteredProjection>();
  private readonly projectionNames = new Set<string>();
  private readonly reportedIssues = new Set<string>();
  private namesPrepared = false;

  constructor(
    readonly program: Program,
    readonly options: TypePlannerOptions = {},
  ) {}

  /** Collect every declaration reachable from the supplied roots and assign deterministic names. */
  prepare(rootTypes: readonly Type[]): void {
    for (const type of rootTypes) this.visitType(type);
    this.assignGeneratedNames();
  }

  get declarations(): readonly NamedType[] {
    this.ensureNamesPrepared();
    return this.namedTypes;
  }

  getGeneratedName(type: NamedType): string {
    this.ensureNamesPrepared();
    const name = this.generatedNames.get(type);
    if (!name) throw new Error(`Type ${type.name || type.kind} was not prepared for generation.`);
    return name;
  }

  typeToTs(type: Type): string {
    const substituted = this.substituteType(type);
    if (substituted !== type) return this.typeToTs(substituted);
    switch (type.kind) {
      case "Model":
        if (this.isFileModel(type)) return "File";
        if (this.isStreamModel(type)) {
          const element = this.options.streamElementTypes?.get(type);
          return element ? `readonly ${this.typeToTs(element)}[]` : "never";
        }
        if (this.isNamedUserType(type)) return this.getGeneratedName(type);
        return this.modelExpressionToTs(type);
      case "Scalar":
        if (this.isNamedUserType(type)) return this.getGeneratedName(type);
        return this.scalarSemanticType(type);
      case "Enum":
        if (this.isNamedUserType(type)) return this.getGeneratedName(type);
        return (
          [...type.members.values()].map((member) => this.enumMemberToTs(member)).join(" | ") ||
          "never"
        );
      case "EnumMember":
        return this.enumMemberToTs(type);
      case "Union":
        if (this.isNamedUserType(type)) return this.getGeneratedName(type);
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
        return type.valueAsString;
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
    const codec: ValueCodecDocument = {
      root: rootCodec,
      ...(Object.keys(state.codecDefinitions).length > 0
        ? { definitions: state.codecDefinitions }
        : {}),
    };
    return {
      schema,
      codec,
      semanticType: types
        .map((item) =>
          projection ? this.projectedTypeToTs(item, projection) : this.typeToTs(item),
        )
        .join(" | "),
    };
  }

  /** Every type exported by {@link emitModels}, including protocol visibility projections. */
  get emittedTypeNames(): readonly string[] {
    this.ensureNamesPrepared();
    return [
      ...this.namedTypes.map((type) => this.getGeneratedName(type)),
      ...[...this.projections.values()].flatMap((projection) =>
        [...projection.types].map((type) => this.getProjectionTypeName(type, projection)),
      ),
    ];
  }

  emitModels(): string {
    this.ensureNamesPrepared();
    const declarations = [
      ...this.namedTypes.map((type) => this.emitNamedType(type)),
      ...[...this.projections.values()].flatMap((projection) =>
        [...projection.types].map((type) => this.emitProjectedNamedType(type, projection)),
      ),
    ].join("\n\n");
    const temporalImport =
      this.options.datetimeMode === "temporal"
        ? 'import type { Temporal } from "@js-temporal/polyfill";\n\n'
        : "";
    return `// Generated by @typespex/mcp. Do not edit.\n${temporalImport}${declarations}${declarations ? "\n" : ""}`;
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
    const additional = this.modelIndexer(type)?.value;
    if (additional) {
      const object = `{ ${properties.join("; ")} }`;
      return `${documentation}export type ${name} = ${object} & Record<string, ${this.projectedTypeToTs(additional, projection)}>;`;
    }
    return `${documentation}export interface ${name} {\n${properties.map((property) => `  ${property};`).join("\n")}\n}`;
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
        const additional = this.modelIndexer(type)?.value;
        if (additional) {
          const object = `{ ${properties.join("; ")} }`;
          return `${documentation}export type ${name} = ${object} & Record<string, ${this.typeToTs(additional)}>;`;
        }
        return `${documentation}export interface ${name} {\n${properties.map((property) => `  ${property};`).join("\n")}\n}`;
      }
      case "Scalar":
        return `${documentation}export type ${name} = ${this.scalarSemanticType(type)};`;
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
    const additional = this.modelIndexer(model)?.value;
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
    const substituted = this.substituteType(type);
    if (substituted !== type) {
      this.collectProjectionTypes(substituted, projection);
      return;
    }
    switch (type.kind) {
      case "Model":
        if (this.isFileModel(type)) return;
        if (this.isStreamModel(type)) {
          const element = this.options.streamElementTypes?.get(type);
          if (element) this.collectProjectionTypes(element, projection);
          return;
        }
        if (this.isNamedUserType(type)) {
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
        const additional = this.modelIndexer(type)?.value;
        if (additional) this.collectProjectionTypes(additional, projection);
        return;
      case "Union":
        if (this.isNamedUserType(type)) {
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
    const substituted = this.substituteType(type);
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
        if (this.isFileModel(type)) break;
        if (this.isStreamModel(type)) {
          const element = this.options.streamElementTypes?.get(type);
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
        const additional = this.modelIndexer(type)?.value;
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
    const baseName = typescriptIdentifier(
      `${this.getGeneratedName(type)}${pascalCase(projection.key)}`,
      "ProjectedType",
    );
    let name = baseName;
    let suffix = 2;
    const originalNames = new Set(this.generatedNames.values());
    while (originalNames.has(name) || this.projectionNames.has(name)) {
      name = `${baseName}${suffix++}`;
    }
    projection.names.set(type, name);
    this.projectionNames.add(name);
    return name;
  }

  private projectedTypeToTs(type: Type, projection: RegisteredProjection): string {
    const substituted = this.substituteType(type);
    if (substituted !== type) return this.projectedTypeToTs(substituted, projection);
    switch (type.kind) {
      case "Model":
        if (this.isFileModel(type)) return "File";
        if (this.isStreamModel(type)) {
          const element = this.options.streamElementTypes?.get(type);
          return element ? `readonly ${this.projectedTypeToTs(element, projection)}[]` : "never";
        }
        if (this.isNamedUserType(type)) {
          if (!this.projectionChangesType(type, projection)) return this.typeToTs(type);
          this.collectProjectionTypes(type, projection);
          return this.getProjectionTypeName(type, projection);
        }
        if (isArrayModelType(this.program, type)) {
          return `ReadonlyArray<${this.projectedTypeToTs(type.indexer.value, projection)}>`;
        }
        return this.projectedModelExpressionToTs(type, projection);
      case "Union":
        if (this.isNamedUserType(type)) {
          if (!this.projectionChangesType(type, projection)) return this.typeToTs(type);
          this.collectProjectionTypes(type, projection);
          return this.getProjectionTypeName(type, projection);
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

  private projectedModelExpressionToTs(model: Model, projection: RegisteredProjection): string {
    const properties = [...walkPropertiesInherited(model)]
      .filter(projection.propertyFilter)
      .map((property) => {
        const optional = property.optional || property.defaultValue !== undefined ? "?" : "";
        return `${typescriptProperty(property.name)}${optional}: ${this.projectedTypeToTs(property.type, projection)}`;
      });
    let expression =
      properties.length > 0 ? `{ ${properties.join("; ")} }` : "Record<string, never>";
    const additional = this.modelIndexer(model)?.value;
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
    const substituted = this.substituteType(type);
    if (substituted !== type) {
      return this.schemaForType(substituted, state, encodingTarget, inlineNamed, propertyFilter);
    }
    const useSiteScalarEncoding =
      type.kind === "Scalar" &&
      encodingTarget !== undefined &&
      encodingTarget !== type &&
      getEncode(this.program, encodingTarget) !== undefined;
    const protocolModel =
      type.kind === "Model" && (this.isFileModel(type) || this.isStreamModel(type));
    if (
      !inlineNamed &&
      !useSiteScalarEncoding &&
      !protocolModel &&
      isNamedType(type) &&
      this.isNamedUserType(type)
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
        schema = this.scalarSchema(type, encodingTarget ?? type);
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
            ? { type: "string", const: type.valueAsString }
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
          `TypeSpec type kind ${type.kind} is not representable in MCP JSON Schema.`,
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
    if (this.isStreamModel(model)) {
      const element = this.options.streamElementTypes?.get(model);
      if (element) {
        return {
          type: "array",
          items: this.schemaForType(element, state, undefined, false, propertyFilter),
        };
      }
      this.report(
        "unsupported-stream",
        "Native MCP tools cannot accept or return TypeSpec streams.",
        model,
      );
      return false;
    }
    if (this.isFileModel(model)) {
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
      if (!property.optional && property.defaultValue === undefined) required.push(wireName);
    }
    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: this.modelIndexer(model)?.value
        ? this.schemaForType(
            this.modelIndexer(model)!.value,
            state,
            undefined,
            false,
            propertyFilter,
          )
        : false,
    };
  }

  private scalarSchema(scalar: Scalar, encodingTarget: ModelProperty | Scalar): JsonSchema {
    const intrinsic = this.intrinsicScalarName(scalar);
    const declaredEncode = this.effectiveEncode(scalar, encodingTarget);
    if (
      this.options.canonicalJsonWire &&
      declaredEncode &&
      !this.validateCanonicalProtocolEncoding(scalar, declaredEncode, encodingTarget)
    ) {
      return false;
    }
    const encode = this.options.canonicalJsonWire ? undefined : declaredEncode;
    const wireIntrinsic = encode ? this.intrinsicScalarName(encode.type) : undefined;
    const encodedAsString = wireIntrinsic === "string";
    const declaredAsString =
      declaredEncode !== undefined && this.intrinsicScalarName(declaredEncode.type) === "string";

    if (["int64", "uint64", "integer"].includes(intrinsic)) {
      if (this.integerRangeIsJsonSafe(scalar, encodingTarget) && !encodedAsString) {
        return { type: "integer" };
      }
      if (encodedAsString || (this.options.canonicalJsonWire && declaredAsString)) {
        return {
          type: "string",
          pattern: intrinsic === "uint64" ? "^(?:0|[1-9]\\d*)$" : "^-?(?:0|[1-9]\\d*)$",
        };
      }
      this.report(
        "unsafe-number",
        `${intrinsic} must use @encode(string) for MCP because JSON number parsing cannot preserve its full range.`,
        encodingTarget,
      );
      return false;
    }
    if (["numeric", "decimal", "decimal128"].includes(intrinsic)) {
      if (!encodedAsString && !(this.options.canonicalJsonWire && declaredAsString)) {
        this.report(
          "unsafe-number",
          `${intrinsic} must use @encode(string) for MCP so decimal precision is not lost.`,
          encodingTarget,
        );
        return false;
      }
      return { type: "string", pattern: "^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?$" };
    }
    if (
      encodedAsString &&
      [
        "int8",
        "uint8",
        "int16",
        "uint16",
        "int32",
        "uint32",
        "safeint",
        "float",
        "float32",
        "float64",
      ].includes(intrinsic)
    ) {
      const integer = !["float", "float32", "float64"].includes(intrinsic);
      return {
        type: "string",
        pattern: integer
          ? "^-?(?:0|[1-9]\\d*)$"
          : "^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?$",
      };
    }

    switch (intrinsic) {
      case "string":
        return { type: "string" };
      case "url":
        return { type: "string", format: "uri" };
      case "boolean":
        return encodedAsString ? { type: "string", enum: ["true", "false"] } : { type: "boolean" };
      case "bytes": {
        const encoding = encode?.encoding ?? "base64";
        if (encoding !== "base64" && encoding !== "base64url") {
          this.report(
            "unsupported-encoding",
            `Bytes encoding ${JSON.stringify(encoding)} is not supported by MCP.`,
            encodingTarget,
          );
          return false;
        }
        return { type: "string", contentEncoding: encoding };
      }
      case "plainDate":
        return { type: "string", format: "date" };
      case "plainTime":
        return { type: "string", format: "time" };
      case "utcDateTime":
      case "offsetDateTime":
        if (encode && encode.encoding && encode.encoding !== "rfc3339") {
          this.report(
            "unsupported-encoding",
            `Date/time encoding ${JSON.stringify(encode.encoding)} is not supported by the native MCP target.`,
            encodingTarget,
          );
          return false;
        }
        return { type: "string", format: "date-time" };
      case "duration":
        if (encode && encode.encoding && encode.encoding !== "ISO8601") {
          this.report(
            "unsupported-encoding",
            `Duration encoding ${JSON.stringify(encode.encoding)} is not supported by the native MCP target.`,
            encodingTarget,
          );
          return false;
        }
        return { type: "string", format: "duration" };
      case "int8":
        return { type: "integer", minimum: -128, maximum: 127 };
      case "uint8":
        return { type: "integer", minimum: 0, maximum: 255 };
      case "int16":
        return { type: "integer", minimum: -32768, maximum: 32767 };
      case "uint16":
        return { type: "integer", minimum: 0, maximum: 65535 };
      case "int32":
        return { type: "integer", minimum: -2147483648, maximum: 2147483647 };
      case "uint32":
        return { type: "integer", minimum: 0, maximum: 4294967295 };
      case "safeint":
        return {
          type: "integer",
          minimum: Number.MIN_SAFE_INTEGER,
          maximum: Number.MAX_SAFE_INTEGER,
        };
      case "float32":
      case "float64":
      case "float":
        return { type: "number" };
      default:
        if (scalar.baseScalar) return this.scalarSchema(scalar.baseScalar, encodingTarget);
        this.report(
          "unsupported-type",
          `Scalar ${scalar.name} has no supported TypeSpec intrinsic base.`,
          scalar,
        );
        return {};
    }
  }

  private codecForType(
    type: Type,
    state: DocumentState,
    encodingTarget?: ModelProperty | Scalar,
    inlineNamed = false,
    propertyFilter?: (property: ModelProperty) => boolean,
  ): ValueCodecSpec {
    const substituted = this.substituteType(type);
    if (substituted !== type) {
      return this.codecForType(substituted, state, encodingTarget, inlineNamed, propertyFilter);
    }
    const useSiteScalarEncoding =
      type.kind === "Scalar" &&
      encodingTarget !== undefined &&
      encodingTarget !== type &&
      getEncode(this.program, encodingTarget) !== undefined;
    const protocolModel =
      type.kind === "Model" && (this.isFileModel(type) || this.isStreamModel(type));
    if (
      !inlineNamed &&
      !useSiteScalarEncoding &&
      !protocolModel &&
      isNamedType(type) &&
      this.isNamedUserType(type)
    ) {
      this.ensureCodecDefinition(type, state, propertyFilter);
      return { kind: "ref", name: this.getGeneratedName(type) };
    }

    switch (type.kind) {
      case "Model":
        if (this.isFileModel(type)) return { kind: "file" };
        if (this.isStreamModel(type)) {
          const element = this.options.streamElementTypes?.get(type);
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
        return this.scalarCodec(type, encodingTarget ?? type);
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
        return value === null ? { kind: "primitive", type: "string" } : { kind: "literal", value };
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
        ...(property.optional ? { optional: true } : {}),
        ...(defaultValue.present ? { hasDefault: true, defaultValue: defaultValue.value } : {}),
      };
    }
    return {
      kind: "object",
      properties,
      ...(this.modelIndexer(model)?.value
        ? {
            additionalProperties: this.codecForType(
              this.modelIndexer(model)!.value,
              state,
              undefined,
              false,
              propertyFilter,
            ),
          }
        : {}),
    };
  }

  private scalarCodec(scalar: Scalar, encodingTarget: ModelProperty | Scalar): ValueCodecSpec {
    const intrinsic = this.intrinsicScalarName(scalar);
    const declaredEncode = this.effectiveEncode(scalar, encodingTarget);
    const encode = this.options.canonicalJsonWire ? undefined : declaredEncode;
    const wireIntrinsic = encode ? this.intrinsicScalarName(encode.type) : undefined;
    const encodedAsString = wireIntrinsic === "string";
    const declaredAsString =
      declaredEncode !== undefined && this.intrinsicScalarName(declaredEncode.type) === "string";
    if (
      ["int64", "uint64", "integer"].includes(intrinsic) &&
      this.integerRangeIsJsonSafe(scalar, encodingTarget) &&
      !encodedAsString
    ) {
      return { kind: "bigint-number" };
    }
    if (
      ["int64", "uint64", "integer"].includes(intrinsic) &&
      (encodedAsString || (this.options.canonicalJsonWire && declaredAsString))
    ) {
      return { kind: "bigint-string" };
    }
    if (
      ["numeric", "decimal", "decimal128"].includes(intrinsic) &&
      (encodedAsString || (this.options.canonicalJsonWire && declaredAsString))
    ) {
      return { kind: "decimal-string" };
    }
    if (
      encodedAsString &&
      [
        "int8",
        "uint8",
        "int16",
        "uint16",
        "int32",
        "uint32",
        "safeint",
        "float",
        "float32",
        "float64",
      ].includes(intrinsic)
    ) {
      return {
        kind: "number-string",
        integer: !["float", "float32", "float64"].includes(intrinsic),
      };
    }
    if (intrinsic === "boolean" && encodedAsString) return { kind: "boolean-string" };
    if (intrinsic === "bytes") {
      const encoding = encode?.encoding === "base64url" ? "base64url" : "base64";
      return { kind: "bytes", encoding };
    }
    if (
      ["plainDate", "plainTime", "utcDateTime", "offsetDateTime", "duration"].includes(intrinsic)
    ) {
      const format =
        intrinsic === "plainDate"
          ? "date"
          : intrinsic === "plainTime"
            ? "time"
            : intrinsic === "duration"
              ? "duration"
              : "date-time";
      return {
        kind: "date-time",
        representation: this.options.datetimeMode ?? "string",
        format,
        ...(this.options.datetimeMode === "temporal"
          ? {
              temporalKind:
                intrinsic === "plainDate"
                  ? ("plain-date" as const)
                  : intrinsic === "plainTime"
                    ? ("plain-time" as const)
                    : intrinsic === "duration"
                      ? ("duration" as const)
                      : intrinsic === "offsetDateTime"
                        ? ("zoned-date-time" as const)
                        : ("instant" as const),
            }
          : {}),
      };
    }
    if (scalar.baseScalar && !this.program.checker.isStdType(scalar)) {
      return this.scalarCodec(scalar.baseScalar, encodingTarget);
    }
    if (intrinsic === "string" || intrinsic === "url") {
      return { kind: "primitive", type: "string" };
    }
    if (intrinsic === "boolean") return { kind: "primitive", type: "boolean" };
    if (
      [
        "int8",
        "uint8",
        "int16",
        "uint16",
        "int32",
        "uint32",
        "safeint",
        "float",
        "float32",
        "float64",
      ].includes(intrinsic)
    ) {
      return { kind: "primitive", type: "number" };
    }
    return { kind: "identity" };
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
    return { present: true, value: this.valueToJson(property.defaultValue, property) };
  }

  private valueToJson(value: Value, target: ModelProperty): unknown {
    switch (value.valueKind) {
      case "StringValue":
        return value.value;
      case "BooleanValue":
        return value.value;
      case "NullValue":
        return null;
      case "NumericValue": {
        const encode =
          target.type.kind === "Scalar"
            ? this.effectiveEncode(target.type, target)
            : getEncode(this.program, target);
        const number = value.value.asNumber();
        const canonicalString =
          this.options.canonicalJsonWire &&
          target.type.kind === "Scalar" &&
          (["numeric", "decimal", "decimal128"].includes(this.intrinsicScalarName(target.type)) ||
            (["int64", "uint64", "integer"].includes(this.intrinsicScalarName(target.type)) &&
              !this.integerRangeIsJsonSafe(target.type, target)));
        return (encode &&
          this.intrinsicScalarName(encode.type) === "string" &&
          !this.options.canonicalJsonWire) ||
          canonicalString
          ? value.value.toString()
          : (number ?? value.value.toString());
      }
      case "EnumValue":
        return this.enumMemberValue(value.value);
      case "ArrayValue":
        return value.values.map((item) => this.valueToJson(item, target));
      case "ObjectValue":
        return Object.fromEntries(
          [...value.properties.values()].map((property) => [
            property.name,
            this.valueToJson(property.value, target),
          ]),
        );
      default:
        return undefined;
    }
  }

  private visitType(type: Type): void {
    const substituted = this.substituteType(type);
    if (substituted !== type) {
      this.visitType(substituted);
      return;
    }
    switch (type.kind) {
      case "Model":
        if (this.isStreamModel(type)) {
          const element = this.options.streamElementTypes?.get(type);
          if (element) {
            this.visitType(element);
            return;
          }
          this.report(
            "unsupported-stream",
            "Native MCP tools cannot accept or return TypeSpec streams.",
            type,
          );
          return;
        }
        if (this.isFileModel(type)) return;
        if (this.isNamedUserType(type)) this.addNamedType(type);
        if (this.expandedTypes.has(type)) return;
        this.expandedTypes.add(type);
        if (isArrayModelType(this.program, type)) {
          this.visitType(type.indexer.value);
          return;
        }
        if (type.baseModel) this.visitType(type.baseModel);
        for (const property of type.properties.values()) this.visitType(property.type);
        const additional = this.modelIndexer(type)?.value;
        if (additional) this.visitType(additional);
        return;
      case "Scalar":
        if (this.isNamedUserType(type)) this.addNamedType(type);
        if (type.baseScalar) this.visitType(type.baseScalar);
        return;
      case "Enum":
        if (this.isNamedUserType(type)) this.addNamedType(type);
        return;
      case "Union":
        if (this.isNamedUserType(type)) this.addNamedType(type);
        if (this.expandedTypes.has(type)) return;
        this.expandedTypes.add(type);
        for (const variant of type.variants.values()) this.visitType(variant.type);
        return;
      case "UnionVariant":
      case "ModelProperty":
        this.visitType(type.type);
        return;
      case "Tuple":
        for (const item of type.values) this.visitType(item);
        return;
      default:
        return;
    }
  }

  private addNamedType(type: NamedType): void {
    if (this.includedTypes.has(type)) return;
    this.includedTypes.add(type);
    this.namedTypes.push(type);
    this.namesPrepared = false;
  }

  private substituteType(type: Type): Type {
    return type.kind === "Model" ? (this.options.typeSubstitutions?.get(type) ?? type) : type;
  }

  private assignGeneratedNames(): void {
    if (this.namesPrepared) return;
    this.generatedNames.clear();
    const used = new Map<string, NamedType>();
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
      used.set(candidate, type);
      this.generatedNames.set(type, candidate);
    }
    this.namesPrepared = true;
  }

  private ensureNamesPrepared(): void {
    if (!this.namesPrepared) this.assignGeneratedNames();
  }

  private isNamedUserType(type: NamedType): boolean {
    if (!type.name || this.isTypeSpecNamespace(type.namespace)) return false;
    return true;
  }

  private isTypeSpecNamespace(namespace: NamedType["namespace"]): boolean {
    let current = namespace;
    while (current) {
      if (current.name === "TypeSpec") return true;
      current = current.namespace;
    }
    return false;
  }

  private isFileModel(model: Model): boolean {
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

  private modelIndexer(model: Model): Model["indexer"] | undefined {
    let current: Model | undefined = model;
    while (current) {
      if (current.indexer) return current.indexer;
      current = current.baseModel;
    }
    return undefined;
  }

  private isStreamModel(model: Model): boolean {
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

  private intrinsicScalarName(scalar: Scalar): string {
    let current: Scalar | undefined = scalar;
    while (current) {
      if (this.program.checker.isStdType(current)) return current.name;
      current = current.baseScalar;
    }
    return scalar.name;
  }

  private scalarSemanticType(scalar: Scalar): string {
    const intrinsic = this.intrinsicScalarName(scalar);
    switch (intrinsic) {
      case "int64":
      case "uint64":
      case "integer":
        return "bigint";
      case "numeric":
      case "decimal":
      case "decimal128":
        return "string";
      case "int8":
      case "int16":
      case "int32":
      case "uint8":
      case "uint16":
      case "uint32":
      case "safeint":
      case "float":
      case "float32":
      case "float64":
        return "number";
      case "boolean":
        return "boolean";
      case "bytes":
        return "Uint8Array";
      case "plainDate":
        return this.options.datetimeMode === "temporal" ? "Temporal.PlainDate" : "string";
      case "plainTime":
        return this.options.datetimeMode === "temporal" ? "Temporal.PlainTime" : "string";
      case "utcDateTime":
        if (this.options.datetimeMode === "date") return "Date";
        if (this.options.datetimeMode === "temporal") return "Temporal.Instant";
        return "string";
      case "offsetDateTime":
        if (this.options.datetimeMode === "date") return "Date";
        if (this.options.datetimeMode === "temporal") return "Temporal.ZonedDateTime";
        return "string";
      case "duration":
        return this.options.datetimeMode === "temporal" ? "Temporal.Duration" : "string";
      case "string":
      case "url":
        return "string";
      default:
        return scalar.baseScalar ? this.scalarSemanticType(scalar.baseScalar) : "unknown";
    }
  }

  private effectiveEncode(scalar: Scalar, target: ModelProperty | Scalar): EncodeData | undefined {
    if (target.kind === "ModelProperty") {
      const propertyEncode = getEncode(this.program, target);
      if (propertyEncode) return propertyEncode;
    }
    let current: Scalar | undefined = scalar;
    while (current) {
      const encode = getEncode(this.program, current);
      if (encode) return encode;
      current = current.baseScalar;
    }
    return undefined;
  }

  private validateCanonicalProtocolEncoding(
    scalar: Scalar,
    encode: EncodeData,
    target: ModelProperty | Scalar,
  ): boolean {
    const semantic = this.intrinsicScalarName(scalar);
    const wire = this.intrinsicScalarName(encode.type);
    const encoding = encode.encoding;
    const numeric = [
      "int8",
      "uint8",
      "int16",
      "uint16",
      "int32",
      "uint32",
      "int64",
      "uint64",
      "integer",
      "safeint",
      "float",
      "float32",
      "float64",
      "numeric",
      "decimal",
      "decimal128",
    ];
    const integer = [
      "int8",
      "uint8",
      "int16",
      "uint16",
      "int32",
      "uint32",
      "int64",
      "uint64",
      "integer",
      "safeint",
    ];
    const supported =
      encoding === undefined
        ? wire === "string" && (semantic === "boolean" || numeric.includes(semantic))
        : encoding === "rfc3339" || encoding === "rfc7231"
          ? wire === "string" && ["utcDateTime", "offsetDateTime"].includes(semantic)
          : encoding === "unixTimestamp"
            ? semantic === "utcDateTime" && integer.includes(wire)
            : encoding === "ISO8601"
              ? semantic === "duration" && wire === "string"
              : encoding === "seconds" || encoding === "milliseconds"
                ? semantic === "duration" && numeric.includes(wire)
                : encoding === "base64" || encoding === "base64url"
                  ? semantic === "bytes" && wire === "string"
                  : false;
    if (supported) return true;
    this.report(
      "unsupported-encoding",
      `Scalar encoding ${JSON.stringify(encoding ?? "string")} is not supported for ${semantic} encoded as ${wire}.`,
      target,
    );
    return false;
  }

  private integerRangeIsJsonSafe(scalar: Scalar, target: ModelProperty | Scalar): boolean {
    const minimum =
      getMinValueAsNumeric(this.program, target) ??
      getMinValueExclusiveAsNumeric(this.program, target) ??
      (target === scalar
        ? undefined
        : (getMinValueAsNumeric(this.program, scalar) ??
          getMinValueExclusiveAsNumeric(this.program, scalar)));
    const maximum =
      getMaxValueAsNumeric(this.program, target) ??
      getMaxValueExclusiveAsNumeric(this.program, target) ??
      (target === scalar
        ? undefined
        : (getMaxValueAsNumeric(this.program, scalar) ??
          getMaxValueExclusiveAsNumeric(this.program, scalar)));
    const min = minimum?.asNumber();
    const max = maximum?.asNumber();
    return (
      min !== undefined &&
      min !== null &&
      max !== undefined &&
      max !== null &&
      Number.isSafeInteger(min) &&
      Number.isSafeInteger(max) &&
      min >= Number.MIN_SAFE_INTEGER &&
      max <= Number.MAX_SAFE_INTEGER
    );
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

  private report(code: CodegenIssue["code"], message: string, target: DiagnosticTarget): void {
    const key = `${code}:${message}`;
    if (this.reportedIssues.has(key)) return;
    this.reportedIssues.add(key);
    this.options.onIssue?.({ code, message, target });
  }
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
