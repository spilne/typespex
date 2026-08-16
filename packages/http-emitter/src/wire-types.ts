import {
  getMaxLength,
  getMinLength,
  getPatternData,
  type Program,
  type Scalar,
  type Type,
} from "@typespec/compiler";
import type { HttpOperationFileBody } from "@typespec/http";
import { scalarToTs } from "./scalar-map.js";

export function isBytesScalar(type: Type): boolean {
  if (type.kind !== "Scalar") return false;
  let current: Scalar | undefined = type;
  while (current) {
    if (current.namespace?.name === "TypeSpec") return current.name === "bytes";
    current = current.baseScalar;
  }
  return false;
}

/**
 * Web File keeps contents behind an asynchronous Blob interface, while
 * generated request validation and response encoding are synchronous at the
 * value boundary. Reject constraints we cannot enforce instead of silently
 * dropping them.
 */
export function unsupportedFileContentsReason(
  program: Program,
  body: HttpOperationFileBody,
): string | undefined {
  const decorators = new Set<string>();
  const targets: Type[] = [];
  let property = body.contents as typeof body.contents | undefined;
  while (property) {
    targets.push(property);
    property = property.sourceProperty as typeof body.contents | undefined;
  }

  let scalar: Scalar | undefined = body.contents.type;
  while (scalar) {
    targets.push(scalar);
    scalar = scalar.baseScalar;
  }

  for (const target of targets) {
    if (getMinLength(program, target) !== undefined) decorators.add("@minLength");
    if (getMaxLength(program, target) !== undefined) decorators.add("@maxLength");
    if (getPatternData(program, target) !== undefined) decorators.add("@pattern");
  }
  if (decorators.size === 0) return undefined;

  return `file transport cannot enforce ${[...decorators].join(", ")} on File.contents`;
}

/** Values that the text response encoder can serialize without object/byte coercion. */
export function isTextResponseType(type: Type): boolean {
  switch (type.kind) {
    case "Scalar": {
      const tsType = scalarToTs(type);
      return tsType !== "unknown" && tsType !== "Uint8Array";
    }
    case "Enum":
    case "EnumMember":
    case "String":
    case "StringTemplate":
    case "Number":
    case "Boolean":
      return true;
    case "Union":
      return [...type.variants.values()].every((variant) => isTextResponseType(variant.type));
    case "UnionVariant":
    case "ModelProperty":
      return isTextResponseType(type.type);
    default:
      return false;
  }
}
