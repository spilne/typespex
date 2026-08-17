import {
  getEncode,
  getMaxValueAsNumeric,
  getMaxValueExclusiveAsNumeric,
  getMinValueAsNumeric,
  getMinValueExclusiveAsNumeric,
  isArrayModelType,
  resolveEncodedName,
  walkPropertiesInherited,
  type EncodeData,
  type Model,
  type ModelProperty,
  type Program,
  type Type,
} from "@typespec/compiler";
import type { HttpWireValuePlan } from "@typespex/http-client";
import type { HttpValueContext } from "./http-media.js";
import { scalarIntrinsic } from "./http-type-utils.js";

export function createHttpWireValuePlan(
  program: Program,
  type: Type,
  encodingTarget: ModelProperty | import("@typespec/compiler").Scalar | undefined,
  sourceContentType: string | undefined,
  context: HttpValueContext = "value",
): HttpWireValuePlan {
  return createHttpWireValuePlanInner(program, type, encodingTarget, sourceContentType, context, {
    visiting: new Set(),
    recursive: new Set(),
    names: new Map(),
    nextName: 0,
  });
}

interface HttpWirePlanningState {
  readonly visiting: Set<Model>;
  readonly recursive: Set<Model>;
  readonly names: Map<Model, string>;
  nextName: number;
}

function createHttpWireValuePlanInner(
  program: Program,
  type: Type,
  encodingTarget: ModelProperty | import("@typespec/compiler").Scalar | undefined,
  sourceContentType: string | undefined,
  context: HttpValueContext,
  state: HttpWirePlanningState,
): HttpWireValuePlan {
  const mediaType = sourceContentType ?? "application/json";
  switch (type.kind) {
    case "Model": {
      if (state.visiting.has(type)) {
        state.recursive.add(type);
        return { kind: "ref", name: httpWireDefinitionName(type, state) };
      }
      if (isHttpFileModel(type)) {
        const contentType = inheritedProperty(type, "contentType");
        const filename = inheritedProperty(type, "filename");
        const contents = inheritedProperty(type, "contents");
        if (!contents) return { kind: "identity" };
        return {
          kind: "file-json",
          ...(contentType
            ? { contentTypeSource: resolveEncodedName(program, contentType, mediaType) }
            : {}),
          ...(filename ? { filenameSource: resolveEncodedName(program, filename, mediaType) } : {}),
          contentsSource: resolveEncodedName(program, contents, mediaType),
          textContents:
            contents.type.kind === "Scalar" && scalarIntrinsic(program, contents.type) === "string",
        };
      }
      state.visiting.add(type);
      let value: HttpWireValuePlan;
      if (isArrayModelType(program, type)) {
        value = {
          kind: "array",
          item: createHttpWireValuePlanInner(
            program,
            type.indexer.value,
            undefined,
            sourceContentType,
            context,
            state,
          ),
        };
      } else {
        const properties = Object.fromEntries(
          [...walkPropertiesInherited(type)].map((property) => {
            const targetName = resolveEncodedName(program, property, "application/json");
            return [
              targetName,
              {
                sourceName: resolveEncodedName(program, property, mediaType),
                value: createHttpWireValuePlanInner(
                  program,
                  property.type,
                  property,
                  sourceContentType,
                  context,
                  state,
                ),
                optional: property.optional || property.defaultValue !== undefined,
              },
            ];
          }),
        );
        value = {
          kind: "object",
          properties,
          ...(type.indexer?.value
            ? {
                additional: createHttpWireValuePlanInner(
                  program,
                  type.indexer.value,
                  undefined,
                  sourceContentType,
                  context,
                  state,
                ),
              }
            : {}),
        };
      }
      state.visiting.delete(type);
      return state.recursive.has(type)
        ? { kind: "definition", name: httpWireDefinitionName(type, state), value }
        : value;
    }
    case "Scalar": {
      const encoding = scalarHttpEncodingPlan(program, type, encodingTarget, context);
      if (encoding) return encoding;
      const intrinsic = scalarIntrinsic(program, type);
      if (intrinsic === "boolean") return { kind: "boolean" };
      if (
        ["int64", "uint64", "integer"].includes(intrinsic) &&
        integerRangeIsJsonSafe(program, type, encodingTarget ?? type)
      ) {
        return { kind: "number", integer: true };
      }
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
        return {
          kind: "number",
          integer: !["float", "float32", "float64"].includes(intrinsic),
        };
      }
      return { kind: "string" };
    }
    case "Enum":
      return {
        kind: "union",
        variants: [...type.members.values()].map((member) => ({
          kind: "literal" as const,
          value: member.value ?? member.name,
        })),
      };
    case "EnumMember":
      return { kind: "literal", value: type.value ?? type.name };
    case "Union":
      return {
        kind: "union",
        variants: [...type.variants.values()].map((variant) =>
          createHttpWireValuePlanInner(
            program,
            variant.type,
            undefined,
            sourceContentType,
            context,
            state,
          ),
        ),
      };
    case "UnionVariant":
      return createHttpWireValuePlanInner(
        program,
        type.type,
        undefined,
        sourceContentType,
        context,
        state,
      );
    case "ModelProperty":
      return createHttpWireValuePlanInner(
        program,
        type.type,
        type,
        sourceContentType,
        context,
        state,
      );
    case "Tuple":
      return {
        kind: "tuple",
        items: type.values.map((item) =>
          createHttpWireValuePlanInner(program, item, undefined, sourceContentType, context, state),
        ),
      };
    case "String":
      return { kind: "literal", value: type.value };
    case "StringTemplate":
      return type.stringValue === undefined
        ? { kind: "string" }
        : { kind: "literal", value: type.stringValue };
    case "Number": {
      const value = type.numericValue.asNumber();
      return value === null ? { kind: "string" } : { kind: "literal", value };
    }
    case "Boolean":
      return { kind: "literal", value: type.value };
    case "Intrinsic":
      return type.name === "null" ? { kind: "null" } : { kind: "identity" };
    default:
      return { kind: "identity" };
  }
}

function httpWireDefinitionName(type: Model, state: HttpWirePlanningState): string {
  const existing = state.names.get(type);
  if (existing) return existing;
  const name = `${type.name || "Model"}#${state.nextName++}`;
  state.names.set(type, name);
  return name;
}

function scalarHttpEncodingPlan(
  program: Program,
  scalar: import("@typespec/compiler").Scalar,
  target: ModelProperty | import("@typespec/compiler").Scalar | undefined,
  context: HttpValueContext,
): HttpWireValuePlan | undefined {
  const intrinsic = scalarIntrinsic(program, scalar);
  const encode = effectiveEncode(program, scalar, target);
  if (!encode) {
    return context === "header" && ["utcDateTime", "offsetDateTime"].includes(intrinsic)
      ? { kind: "scalar-encoding", encoding: "rfc7231" }
      : undefined;
  }
  const wire = scalarIntrinsic(program, encode.type);
  switch (encode.encoding) {
    case undefined:
      if (wire !== "string") return undefined;
      if (intrinsic === "boolean") {
        return { kind: "scalar-encoding", encoding: "boolean-string" };
      }
      if (
        ["numeric", "decimal", "decimal128"].includes(intrinsic) ||
        (["int64", "uint64", "integer"].includes(intrinsic) &&
          !integerRangeIsJsonSafe(program, scalar, target ?? scalar))
      ) {
        return { kind: "string" };
      }
      if (isNumericIntrinsic(intrinsic)) {
        return {
          kind: "scalar-encoding",
          encoding: isIntegerIntrinsic(intrinsic) ? "integer-string" : "number-string",
        };
      }
      return { kind: "string" };
    case "rfc3339":
    case "ISO8601":
    case "base64":
      return { kind: "string" };
    case "rfc7231":
      return { kind: "scalar-encoding", encoding: "rfc7231" };
    case "unixTimestamp":
      return { kind: "scalar-encoding", encoding: "unix-timestamp" };
    case "seconds":
      return { kind: "scalar-encoding", encoding: "duration-seconds" };
    case "milliseconds":
      return { kind: "scalar-encoding", encoding: "duration-milliseconds" };
    case "base64url":
      return { kind: "scalar-encoding", encoding: "base64url" };
    default:
      return undefined;
  }
}

function effectiveEncode(
  program: Program,
  scalar: import("@typespec/compiler").Scalar,
  target: ModelProperty | import("@typespec/compiler").Scalar | undefined,
): EncodeData | undefined {
  if (target?.kind === "ModelProperty") {
    const property = getEncode(program, target);
    if (property) return property;
  }
  let current: import("@typespec/compiler").Scalar | undefined = scalar;
  while (current) {
    const encode = getEncode(program, current);
    if (encode) return encode;
    current = current.baseScalar;
  }
  return undefined;
}

function isNumericIntrinsic(name: string): boolean {
  return (
    isIntegerIntrinsic(name) ||
    ["float", "float32", "float64", "numeric", "decimal", "decimal128"].includes(name)
  );
}

function isIntegerIntrinsic(name: string): boolean {
  return [
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
  ].includes(name);
}

function integerRangeIsJsonSafe(
  program: Program,
  scalar: import("@typespec/compiler").Scalar,
  target: ModelProperty | import("@typespec/compiler").Scalar,
): boolean {
  const minimum =
    getMinValueAsNumeric(program, target) ??
    getMinValueExclusiveAsNumeric(program, target) ??
    (target === scalar
      ? undefined
      : (getMinValueAsNumeric(program, scalar) ?? getMinValueExclusiveAsNumeric(program, scalar)));
  const maximum =
    getMaxValueAsNumeric(program, target) ??
    getMaxValueExclusiveAsNumeric(program, target) ??
    (target === scalar
      ? undefined
      : (getMaxValueAsNumeric(program, scalar) ?? getMaxValueExclusiveAsNumeric(program, scalar)));
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

function isHttpFileModel(model: Model): boolean {
  let current: Model | undefined = model;
  while (current) {
    if (current.name === "File" && current.namespace?.name === "Http") return true;
    current = current.baseModel;
  }
  return false;
}

function inheritedProperty(model: Model, name: string): ModelProperty | undefined {
  return (
    model.properties.get(name) ??
    (model.baseModel ? inheritedProperty(model.baseModel, name) : undefined)
  );
}
