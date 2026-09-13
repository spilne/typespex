import {
  $maxValue,
  $maxValueExclusive,
  $minValue,
  $minValueExclusive,
  getEncode,
  getMaxValueAsNumeric,
  getMaxValueExclusiveAsNumeric,
  getMinValueAsNumeric,
  getMinValueExclusiveAsNumeric,
  Numeric,
  type EncodeData,
  type ModelProperty,
  type Program,
  type Scalar,
} from "@typespec/compiler";
import { SyntaxKind } from "@typespec/compiler/ast";
import { compareNumericStrings, type NumericConstraints } from "@typespex/codec";

type NumericBounds = { readonly [Key in keyof NumericConstraints]?: Numeric };

const intrinsicBounds: Readonly<Record<string, readonly [string, string]>> = {
  int8: ["-128", "127"],
  uint8: ["0", "255"],
  int16: ["-32768", "32767"],
  uint16: ["0", "65535"],
  int32: ["-2147483648", "2147483647"],
  uint32: ["0", "4294967295"],
  int64: ["-9223372036854775808", "9223372036854775807"],
  uint64: ["0", "18446744073709551615"],
  safeint: ["-9007199254740991", "9007199254740991"],
  float32: ["-3.4e38", "3.4e38"],
  float64: [String(-Number.MAX_VALUE), String(Number.MAX_VALUE)],
};

const numericBoundGetters = {
  minimum: getMinValueAsNumeric,
  maximum: getMaxValueAsNumeric,
  exclusiveMinimum: getMinValueExclusiveAsNumeric,
  exclusiveMaximum: getMaxValueExclusiveAsNumeric,
} as const;

const numericBoundDecorators = {
  minimum: $minValue,
  maximum: $maxValue,
  exclusiveMinimum: $minValueExclusive,
  exclusiveMaximum: $maxValueExclusive,
} as const;

/** Detect literal precision already lost by the compiler's numeric literal cache. */
export function getNumericBoundIssue(
  program: Program,
  scalar: Scalar,
  target: ModelProperty | Scalar,
): string | undefined {
  if (!isNumericIntrinsic(getScalarIntrinsicName(program, scalar))) return undefined;
  const sources: (Scalar | ModelProperty)[] = target === scalar ? [] : [target];
  for (let current: Scalar | undefined = scalar; current; current = current.baseScalar)
    sources.push(current);
  for (const source of sources) {
    for (const key of Object.keys(numericBoundGetters) as (keyof NumericBounds)[]) {
      const bound = numericBoundGetters[key](program, source);
      if (!bound) continue;
      for (const application of source.decorators) {
        if (application.decorator !== numericBoundDecorators[key]) continue;
        const argument = application.args[0];
        if (argument?.node?.kind !== SyntaxKind.NumericLiteral) continue;
        const value = argument.value;
        const resolved =
          value.entityKind === "Value" && value.valueKind === "NumericValue"
            ? value.value
            : value.entityKind === "Type" && value.kind === "Number"
              ? value.numericValue
              : undefined;
        // A later custom decorator may intentionally replace the bound. Only
        // diagnose the standard decorator's own incorrectly resolved literal.
        if (
          resolved &&
          compareNumericStrings(resolved.toString(), bound.toString()) === 0 &&
          compareNumericStrings(
            resolved.toString(),
            Numeric(argument.node.valueAsString).toString(),
          ) !== 0
        ) {
          return `TypeSpec resolved the numeric bound ${argument.node.valueAsString} as ${resolved.toString()}. Its precision was lost before TypeSpex planning; this bound cannot be emitted safely.`;
        }
      }
    }
  }
  return undefined;
}

export function hasNumericBounds(program: Program, target: ModelProperty | Scalar): boolean {
  return Object.values(numericBoundGetters).some((get) => get(program, target) !== undefined);
}

/** Intersect intrinsic, inherited, and property bounds without rounding them. */
export function getNumericBounds(
  program: Program,
  scalar: Scalar,
  target: ModelProperty | Scalar = scalar,
  options: { readonly includeIntrinsic?: boolean } = {},
): NumericBounds {
  const intrinsic = getScalarIntrinsicName(program, scalar);
  if (!isNumericIntrinsic(intrinsic)) return {};
  const bounds: { -readonly [Key in keyof NumericBounds]?: Numeric } = {};
  const intrinsicRange = intrinsicBounds[intrinsic];
  if (intrinsicRange && options.includeIntrinsic !== false) {
    bounds.minimum = Numeric(intrinsicRange[0]);
    bounds.maximum = Numeric(intrinsicRange[1]);
  }
  const sources: (Scalar | ModelProperty)[] = [];
  for (let current: Scalar | undefined = scalar; current; current = current.baseScalar) {
    sources.push(current);
  }
  if (target !== scalar) sources.push(target);
  for (const source of sources) {
    for (const key of Object.keys(numericBoundGetters) as (keyof NumericBounds)[]) {
      const value = numericBoundGetters[key](program, source);
      if (!value) continue;
      const previous = bounds[key];
      const lower = key === "minimum" || key === "exclusiveMinimum";
      if (
        !previous ||
        (lower
          ? compareNumericStrings(value.toString(), previous.toString()) > 0
          : compareNumericStrings(value.toString(), previous.toString()) < 0)
      )
        bounds[key] = value;
    }
  }
  return bounds;
}

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
  const bounds = getNumericBounds(program, scalar, target, { includeIntrinsic: false });
  const minimum =
    bounds.exclusiveMinimum &&
    (!bounds.minimum ||
      compareNumericStrings(bounds.exclusiveMinimum.toString(), bounds.minimum.toString()) > 0)
      ? bounds.exclusiveMinimum
      : bounds.minimum;
  const maximum =
    bounds.exclusiveMaximum &&
    (!bounds.maximum ||
      compareNumericStrings(bounds.exclusiveMaximum.toString(), bounds.maximum.toString()) < 0)
      ? bounds.exclusiveMaximum
      : bounds.maximum;
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
