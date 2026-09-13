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
  type Model,
  type ModelProperty,
  type Program,
  type Scalar,
  type Type,
  type Value,
} from "@typespec/compiler";
import type { ObjectPropertyCodecSpec, ValueCodecDocument, ValueCodecSpec } from "@typespex/codec";
import type { CompilerIssue, JsonSchema, JsonWirePlan } from "./plans.js";
import type { ScalarPlanner } from "./scalar-planner.js";
import { getNumericBounds, hasNumericBounds } from "./scalar-policy.js";
import { isNamedType, type NamedType, type TypeRegistry } from "./type-registry.js";

type SchemaObject = Record<string, unknown>;

type PropertyFilter = (property: ModelProperty) => boolean;

interface DocumentState {
  readonly propertyFilter?: PropertyFilter;
  readonly schemaDefinitions: Record<string, JsonSchema>;
  readonly codecDefinitions: Record<string, ValueCodecSpec>;
  readonly buildingSchemas: Set<NamedType>;
  readonly buildingCodecs: Set<NamedType>;
}

/** Plans JSON schemas, codecs, and defaults for prepared TypeSpec types. */
export class JsonPlanner {
  private readonly transformCache = new Map<PropertyFilter | undefined, Map<NamedType, boolean>>();

  invalidateTransformCache(): void {
    this.transformCache.clear();
  }

  constructor(
    private readonly program: Program,
    private readonly types: TypeRegistry,
    private readonly scalars: ScalarPlanner,
    private readonly report: (
      code: CompilerIssue["code"],
      message: string,
      target: DiagnosticTarget,
    ) => void,
  ) {}

  createPlan(
    types: readonly Type[],
    propertyFilter?: PropertyFilter,
  ): Pick<JsonWirePlan, "schema" | "codec"> {
    const state = createDocumentState(propertyFilter);

    const rootSchema =
      types.length === 1
        ? this.schemaForType(types[0]!, state, undefined, false)
        : {
            anyOf: types.map((item) => this.schemaForType(item, state, undefined, false)),
          };
    const rootCodec =
      types.length === 1
        ? this.codecForType(types[0]!, state, undefined, false)
        : ({
            kind: "union",
            variants: types.map((item) => this.codecForType(item, state, undefined, false)),
          } satisfies ValueCodecSpec);
    const schema = withDocumentMetadata(rootSchema, state.schemaDefinitions);
    const codecDocument: ValueCodecDocument = {
      root: rootCodec,
      ...(Object.keys(state.codecDefinitions).length > 0
        ? { definitions: state.codecDefinitions }
        : {}),
    };
    return {
      schema,
      ...(codecDocumentRequiresTransform(codecDocument) ? { codec: codecDocument } : {}),
    };
  }

  requiresTransform(type: NamedType, propertyFilter?: PropertyFilter): boolean {
    let cache = this.transformCache.get(propertyFilter);
    if (!cache) {
      cache = new Map();
      this.transformCache.set(propertyFilter, cache);
    }
    const cached = cache.get(type);
    if (cached !== undefined) return cached;
    const state = createDocumentState(propertyFilter);
    const document: ValueCodecDocument = {
      root: this.codecForType(type, state, undefined, true),
      ...(Object.keys(state.codecDefinitions).length > 0
        ? { definitions: state.codecDefinitions }
        : {}),
    };
    const result = codecDocumentRequiresTransform(document);
    cache.set(type, result);
    return result;
  }

  private schemaForType(
    type: Type,
    state: DocumentState,
    encodingTarget?: ModelProperty | Scalar,
    inlineNamed = false,
  ): JsonSchema {
    const substituted = this.types.substitute(type);
    if (substituted !== type) {
      return this.schemaForType(substituted, state, encodingTarget, inlineNamed);
    }
    const useSiteScalarEncoding =
      type.kind === "Scalar" &&
      encodingTarget !== undefined &&
      encodingTarget !== type &&
      (getEncode(this.program, encodingTarget) !== undefined ||
        hasNumericBounds(this.program, encodingTarget));
    const protocolModel =
      type.kind === "Model" && (this.types.isFile(type) || this.types.isStream(type));
    if (
      !inlineNamed &&
      !useSiteScalarEncoding &&
      !protocolModel &&
      isNamedType(type) &&
      this.types.isUserDefined(type)
    ) {
      this.ensureSchemaDefinition(type, state);
      const reference = { $ref: `#/$defs/${this.types.getName(type)}` };
      return encodingTarget ? this.applySchemaMetadata(reference, encodingTarget) : reference;
    }

    let schema: JsonSchema;
    switch (type.kind) {
      case "Model":
        schema = this.modelSchema(type, state);
        break;
      case "Scalar":
        schema = this.scalars.schema(type, encodingTarget ?? type);
        break;
      case "Enum":
        schema = { enum: [...type.members.values()].map((member) => member.value ?? member.name) };
        break;
      case "EnumMember":
        schema = { const: type.value ?? type.name };
        break;
      case "Union":
        schema = {
          anyOf: [...type.variants.values()].map((variant) =>
            this.schemaForType(variant.type, state, undefined, false),
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
        );
        break;
      case "Tuple":
        schema = {
          type: "array",
          prefixItems: type.values.map((value) =>
            this.schemaForType(value, state, undefined, false),
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

  private modelSchema(model: Model, state: DocumentState): JsonSchema {
    const { propertyFilter } = state;
    if (this.types.isStream(model)) {
      const element = this.types.streamElement(model);
      if (element) {
        return {
          type: "array",
          items: this.schemaForType(element, state, undefined, false),
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
        items: this.schemaForType(model.indexer.value, state, undefined, false),
      };
    }

    const properties: Record<string, JsonSchema> = Object.create(null) as Record<
      string,
      JsonSchema
    >;
    const required: string[] = [];
    const excludedNames = new Set<string>();
    for (const property of walkPropertiesInherited(model)) {
      const wireName = resolveEncodedName(this.program, property, "application/json");
      if (propertyFilter && !propertyFilter(property)) {
        if (this.types.indexer(model)) {
          excludedNames.add(property.name);
          excludedNames.add(wireName);
        }
        continue;
      }
      let propertySchema = this.schemaForType(property.type, state, property, false);
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
    for (const name of excludedNames) {
      if (!Object.hasOwn(properties, name)) properties[name] = false;
    }
    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: this.types.indexer(model)?.value
        ? this.schemaForType(this.types.indexer(model)!.value, state, undefined, false)
        : false,
    };
  }

  private codecForType(
    type: Type,
    state: DocumentState,
    encodingTarget?: ModelProperty | Scalar,
    inlineNamed = false,
  ): ValueCodecSpec {
    const substituted = this.types.substitute(type);
    if (substituted !== type) {
      return this.codecForType(substituted, state, encodingTarget, inlineNamed);
    }
    const useSiteScalarEncoding =
      type.kind === "Scalar" &&
      encodingTarget !== undefined &&
      encodingTarget !== type &&
      (getEncode(this.program, encodingTarget) !== undefined ||
        hasNumericBounds(this.program, encodingTarget));
    const protocolModel =
      type.kind === "Model" && (this.types.isFile(type) || this.types.isStream(type));
    if (
      !inlineNamed &&
      !useSiteScalarEncoding &&
      !protocolModel &&
      isNamedType(type) &&
      this.types.isUserDefined(type)
    ) {
      this.ensureCodecDefinition(type, state);
      return { kind: "ref", name: this.types.getName(type) };
    }

    switch (type.kind) {
      case "Model":
        if (this.types.isFile(type)) return { kind: "file" };
        if (this.types.isStream(type)) {
          const element = this.types.streamElement(type);
          return element
            ? {
                kind: "array",
                item: this.codecForType(element, state, undefined, false),
              }
            : { kind: "identity" };
        }
        if (isArrayModelType(this.program, type)) {
          return {
            kind: "array",
            item: this.codecForType(type.indexer.value, state, undefined, false),
          };
        }
        return this.objectCodec(type, state);
      case "Scalar":
        return this.scalars.codec(type, encodingTarget ?? type);
      case "Enum":
        return {
          kind: "union",
          variants: [...type.members.values()].map((member) => ({
            kind: "literal",
            value: member.value ?? member.name,
          })),
        };
      case "EnumMember":
        return { kind: "literal", value: type.value ?? type.name };
      case "Union":
        return {
          kind: "union",
          variants: [...type.variants.values()].map((variant) =>
            this.codecForType(variant.type, state, undefined, false),
          ),
        };
      case "UnionVariant":
      case "ModelProperty":
        return this.codecForType(
          type.type,
          state,
          type.kind === "ModelProperty" ? type : undefined,
          false,
        );
      case "Tuple":
        return {
          kind: "tuple",
          items: type.values.map((item) => this.codecForType(item, state, undefined, false)),
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

  private objectCodec(model: Model, state: DocumentState): ValueCodecSpec {
    const { propertyFilter } = state;
    const properties: Record<string, ObjectPropertyCodecSpec> = Object.create(null) as Record<
      string,
      ObjectPropertyCodecSpec
    >;
    const excludedProperties: Record<string, string> = Object.create(null);
    for (const property of walkPropertiesInherited(model)) {
      if (propertyFilter && !propertyFilter(property)) {
        if (this.types.indexer(model)) {
          excludedProperties[property.name] = resolveEncodedName(
            this.program,
            property,
            "application/json",
          );
        }
        continue;
      }
      const defaultValue = this.propertyDefaultValue(property);
      properties[property.name] = {
        wireName: resolveEncodedName(this.program, property, "application/json"),
        codec: this.codecForType(property.type, state, property, false),
        ...(property.optional || defaultValue.present ? { optional: true } : {}),
        ...(defaultValue.present ? { hasDefault: true, defaultValue: defaultValue.value } : {}),
      };
    }
    return {
      kind: "object",
      properties,
      ...(Object.keys(excludedProperties).length > 0 ? { excludedProperties } : {}),
      ...(this.types.indexer(model)?.value
        ? {
            additionalProperties: this.codecForType(
              this.types.indexer(model)!.value,
              state,
              undefined,
              false,
            ),
          }
        : {}),
    };
  }

  private ensureSchemaDefinition(type: NamedType, state: DocumentState): void {
    const name = this.types.getName(type);
    if (Object.prototype.hasOwnProperty.call(state.schemaDefinitions, name)) return;
    if (state.buildingSchemas.has(type)) return;
    state.buildingSchemas.add(type);
    state.schemaDefinitions[name] = this.schemaForType(type, state, undefined, true);
    state.buildingSchemas.delete(type);
  }

  private ensureCodecDefinition(type: NamedType, state: DocumentState): void {
    const name = this.types.getName(type);
    if (Object.prototype.hasOwnProperty.call(state.codecDefinitions, name)) return;
    if (state.buildingCodecs.has(type)) return;
    state.buildingCodecs.add(type);
    // Install a placeholder before descending so direct recursive references resolve.
    state.codecDefinitions[name] = { kind: "identity" };
    state.codecDefinitions[name] = this.codecForType(type, state, undefined, true);
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
    const scalar =
      target.kind === "Scalar"
        ? target
        : target.kind === "ModelProperty" && target.type.kind === "Scalar"
          ? target.type
          : undefined;
    const bounds = scalar
      ? getNumericBounds(this.program, scalar, target as ModelProperty | Scalar)
      : {
          minimum: getMinValueAsNumeric(this.program, target),
          maximum: getMaxValueAsNumeric(this.program, target),
          exclusiveMinimum: getMinValueExclusiveAsNumeric(this.program, target),
          exclusiveMaximum: getMaxValueExclusiveAsNumeric(this.program, target),
        };
    const numericWire =
      !scalar ||
      (Object.keys(bounds).length > 0 &&
        this.scalars.wireType(scalar, target as ModelProperty | Scalar) === "number");
    const min = numericWire ? bounds.minimum?.asNumber() : undefined;
    const max = numericWire ? bounds.maximum?.asNumber() : undefined;
    const minExclusive = numericWire ? bounds.exclusiveMinimum?.asNumber() : undefined;
    const maxExclusive = numericWire ? bounds.exclusiveMaximum?.asNumber() : undefined;
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
        return value.value.value ?? value.value.name;
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
}

function createDocumentState(propertyFilter?: PropertyFilter): DocumentState {
  return {
    propertyFilter,
    schemaDefinitions: Object.create(null) as Record<string, JsonSchema>,
    codecDefinitions: Object.create(null) as Record<string, ValueCodecSpec>,
    buildingSchemas: new Set(),
    buildingCodecs: new Set(),
  };
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
  const pending = [document.root];
  const visited = new Set<ValueCodecSpec>();
  while (pending.length > 0) {
    const spec = pending.pop()!;
    if (visited.has(spec)) continue;
    visited.add(spec);
    if (spec.numericConstraints !== undefined) return true;
    switch (spec.kind) {
      case "identity":
      case "primitive":
      case "literal":
      case "decimal-string":
        break;
      case "date-time":
        if (
          spec.representation === "temporal" ||
          (spec.representation === "date" && spec.format === "date-time")
        )
          return true;
        break;
      case "bigint-string":
      case "bigint-literal-string":
      case "bigint-number":
      case "number-string":
      case "boolean-string":
      case "bytes":
      case "file":
        return true;
      case "array":
        pending.push(spec.item);
        break;
      case "tuple":
        pending.push(...spec.items);
        break;
      case "union":
        pending.push(...spec.variants);
        break;
      case "object":
        if (Object.keys(spec.excludedProperties ?? {}).length > 0) return true;
        for (const [semanticName, property] of Object.entries(spec.properties)) {
          if (property.wireName !== semanticName || property.hasDefault === true) return true;
          pending.push(property.codec);
        }
        if (spec.additionalProperties !== undefined && spec.additionalProperties !== true) {
          pending.push(spec.additionalProperties);
        }
        break;
      case "ref": {
        const target = document.definitions?.[spec.name];
        if (!target) return true;
        pending.push(target);
        break;
      }
      default:
        spec satisfies never;
        return true;
    }
  }
  return false;
}
