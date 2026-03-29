import type { Scalar } from "@typespec/compiler";

/**
 * Maps TypeSpec scalar types to TypeScript type strings.
 */
export function scalarToTs(scalar: Scalar): string {
  const name = getIntrinsicScalarName(scalar);

  switch (name) {
    case "int8":
    case "int16":
    case "int32":
    case "uint8":
    case "uint16":
    case "uint32":
    case "float32":
    case "float64":
    case "integer":
    case "float":
    case "numeric":
    case "decimal":
    case "decimal128":
    case "safeint":
      return "number";

    case "int64":
    case "uint64":
      return "bigint";

    case "string":
    case "url":
      return "string";

    case "boolean":
      return "boolean";

    case "plainDate":
    case "plainTime":
    case "utcDateTime":
    case "offsetDateTime":
    case "duration":
      return "string";

    case "bytes":
      return "Uint8Array";

    default:
      return "unknown";
  }
}

function getIntrinsicScalarName(scalar: Scalar): string {
  let current: Scalar | undefined = scalar;
  while (current) {
    if (current.namespace?.name === "TypeSpec") {
      return current.name;
    }
    current = current.baseScalar;
  }
  return scalar.name;
}
