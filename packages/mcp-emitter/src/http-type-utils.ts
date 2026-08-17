import type { Program, Type } from "@typespec/compiler";

export function isScalarLike(program: Program, type: Type): boolean {
  switch (type.kind) {
    case "Scalar":
    case "String":
    case "StringTemplate":
    case "Number":
    case "Boolean":
    case "EnumMember":
      return true;
    case "Enum":
      return true;
    case "Union":
      return [...type.variants.values()].every((variant) => isScalarLike(program, variant.type));
    case "UnionVariant":
    case "ModelProperty":
      return isScalarLike(program, type.type);
    case "Intrinsic":
      return type.name === "null";
    default:
      return false;
  }
}

export function isBytesLike(program: Program, type: Type): boolean {
  switch (type.kind) {
    case "Scalar":
      return scalarIntrinsic(program, type) === "bytes";
    case "Union":
      return [...type.variants.values()].every((variant) => isBytesLike(program, variant.type));
    case "UnionVariant":
    case "ModelProperty":
      return isBytesLike(program, type.type);
    default:
      return false;
  }
}

export function scalarIntrinsic(
  program: Program,
  scalar: import("@typespec/compiler").Scalar,
): string {
  let current: import("@typespec/compiler").Scalar | undefined = scalar;
  while (current) {
    if (program.checker.isStdType(current)) return current.name;
    current = current.baseScalar;
  }
  return scalar.name;
}
