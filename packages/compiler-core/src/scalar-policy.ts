import {
  getEncode,
  getMaxValueAsNumeric,
  getMaxValueExclusiveAsNumeric,
  getMinValueAsNumeric,
  getMinValueExclusiveAsNumeric,
  type EncodeData,
  type ModelProperty,
  type Program,
  type Scalar,
} from "@typespec/compiler";

export interface ScalarEncodingDeclaration {
  readonly data: EncodeData;
  readonly source: Scalar | ModelProperty;
}

/** Resolve the TypeSpec intrinsic without choosing a protocol or handler representation. */
export function getScalarIntrinsicName(program: Program, scalar: Scalar): string {
  let current: Scalar | undefined = scalar;
  while (current) {
    if (program.checker.isStdType(current)) return current.name;
    current = current.baseScalar;
  }
  return scalar.name;
}

/** Property overrides take precedence over the nearest encoding in the scalar base chain. */
export function getEffectiveScalarEncoding(
  program: Program,
  scalar: Scalar,
  target?: ModelProperty | Scalar,
): ScalarEncodingDeclaration | undefined {
  if (target?.kind === "ModelProperty") {
    const data = getEncode(program, target);
    if (data) return { data, source: target };
  }
  let current: Scalar | undefined = scalar;
  while (current) {
    const data = getEncode(program, current);
    if (data) return { data, source: current };
    current = current.baseScalar;
  }
  return undefined;
}

export function isIntegerIntrinsic(name: string): boolean {
  switch (name) {
    case "int8":
    case "uint8":
    case "int16":
    case "uint16":
    case "int32":
    case "uint32":
    case "int64":
    case "uint64":
    case "integer":
    case "safeint":
      return true;
    default:
      return false;
  }
}

export function isNumericIntrinsic(name: string): boolean {
  if (isIntegerIntrinsic(name)) return true;
  switch (name) {
    case "float":
    case "float32":
    case "float64":
    case "numeric":
    case "decimal":
    case "decimal128":
      return true;
    default:
      return false;
  }
}

/** Checks declared encoding compatibility, not a protocol's default or canonical wire format. */
export function getScalarEncodingIssue(
  semantic: string,
  wire: string,
  encoding: string | undefined,
): string | undefined {
  switch (encoding) {
    case undefined:
      if (wire !== "string") return 'the string encoding must encode as TypeSpec "string"';
      if (semantic === "boolean" || isNumericIntrinsic(semantic)) return undefined;
      return `the string encoding is not supported for semantic scalar ${JSON.stringify(semantic)}`;
    case "rfc3339":
    case "rfc7231":
      if ((semantic === "utcDateTime" || semantic === "offsetDateTime") && wire === "string") {
        return undefined;
      }
      return `${encoding} requires utcDateTime or offsetDateTime encoded as string`;
    case "unixTimestamp":
      if (semantic === "utcDateTime" && isIntegerIntrinsic(wire)) return undefined;
      return "unixTimestamp requires utcDateTime encoded as an integer scalar";
    case "ISO8601":
      if (semantic === "duration" && wire === "string") return undefined;
      return "ISO8601 requires duration encoded as string";
    case "seconds":
    case "milliseconds":
      if (semantic === "duration" && isNumericIntrinsic(wire)) return undefined;
      return `${encoding} requires duration encoded as a numeric scalar`;
    case "base64":
    case "base64url":
      if (semantic === "bytes" && wire === "string") return undefined;
      return `${encoding} requires bytes encoded as string`;
    default:
      return `custom encoding ${JSON.stringify(encoding)} is not supported`;
  }
}

/** Whether explicit bounds fit JSON integers; callers still choose the semantic representation. */
export function isJsonSafeIntegerRange(
  program: Program,
  scalar: Scalar,
  target: ModelProperty | Scalar,
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
