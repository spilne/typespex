import type { Scalar } from "@typespec/compiler";
import { dateTimeHandlerType, type DateTimeMode } from "./datetime-mode.js";

const INTRINSIC_SCALAR_NAMES = new Set([
  "int8",
  "int16",
  "int32",
  "int64",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "float32",
  "float64",
  "integer",
  "float",
  "numeric",
  "decimal",
  "decimal128",
  "safeint",
  "string",
  "url",
  "boolean",
  "plainDate",
  "plainTime",
  "utcDateTime",
  "offsetDateTime",
  "duration",
  "bytes",
]);

/**
 * Maps TypeSpec scalar types to TypeScript type strings.
 */
export function scalarToTs(scalar: Scalar, dateTimeMode: DateTimeMode = "string"): string {
  const name = getIntrinsicScalarName(scalar);
  const dateTimeType = dateTimeHandlerType(scalar, dateTimeMode);
  if (dateTimeType) return dateTimeType;

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

export function getIntrinsicScalarName(scalar: Scalar): string {
  let current: Scalar | undefined = scalar;
  while (current) {
    if (current.namespace?.name === "TypeSpec" && INTRINSIC_SCALAR_NAMES.has(current.name)) {
      return current.name;
    }
    current = current.baseScalar;
  }
  return scalar.name;
}
