import {
  getEncode,
  getMaxValueAsNumeric,
  getMaxValueExclusiveAsNumeric,
  getMinValueAsNumeric,
  getMinValueExclusiveAsNumeric,
  serializeValueAsJson,
  type DiagnosticTarget,
  type EncodeData,
  type ModelProperty,
  type Program,
  type Scalar,
  type Value,
} from "@typespec/compiler";
import type { ValueCodecSpec } from "@typespex/codec";
import type { CompilerIssue, JsonSchema } from "./plans.js";

interface ScalarPlannerOptions {
  readonly datetimeMode?: "string" | "date" | "temporal";
  readonly canonicalJsonWire?: boolean;
  readonly report: (code: CompilerIssue["code"], message: string, target: DiagnosticTarget) => void;
}

const BIGINT_INTRINSICS: ReadonlySet<string> = new Set(["int64", "uint64", "integer"]);
const DECIMAL_INTRINSICS: ReadonlySet<string> = new Set(["numeric", "decimal", "decimal128"]);
const FLOAT_INTRINSICS: ReadonlySet<string> = new Set(["float", "float32", "float64"]);
const NUMBER_INTEGER_INTRINSICS: ReadonlySet<string> = new Set([
  "int8",
  "uint8",
  "int16",
  "uint16",
  "int32",
  "uint32",
  "safeint",
]);
const NUMBER_INTRINSICS: ReadonlySet<string> = new Set([
  ...NUMBER_INTEGER_INTRINSICS,
  ...FLOAT_INTRINSICS,
]);
const INTEGER_INTRINSICS: ReadonlySet<string> = new Set([
  ...NUMBER_INTEGER_INTRINSICS,
  ...BIGINT_INTRINSICS,
]);

const NUMERIC_INTRINSICS: ReadonlySet<string> = new Set([
  ...INTEGER_INTRINSICS,
  ...FLOAT_INTRINSICS,
  ...DECIMAL_INTRINSICS,
]);
const DATE_TIME_INTRINSICS: ReadonlySet<string> = new Set([
  "plainDate",
  "plainTime",
  "utcDateTime",
  "offsetDateTime",
  "duration",
]);

type ScalarDefaultValue = Extract<
  Value,
  { readonly valueKind: "BooleanValue" | "NumericValue" | "ScalarValue" }
>;

interface ScalarDefaultContext {
  readonly scalar?: Scalar;
  readonly encodingTarget?: ModelProperty | Scalar;
}

/** Maps TypeSpec scalars to semantic types, JSON wire schemas, and codecs. */
export class ScalarPlanner {
  constructor(
    private readonly program: Program,
    private readonly options: ScalarPlannerOptions,
  ) {}

  private intrinsicName(scalar: Scalar): string {
    let current: Scalar | undefined = scalar;
    while (current) {
      if (this.program.checker.isStdType(current)) return current.name;
      current = current.baseScalar;
    }
    return scalar.name;
  }

  semanticType(scalar: Scalar): string {
    const intrinsic = this.intrinsicName(scalar);
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
        return scalar.baseScalar ? this.semanticType(scalar.baseScalar) : "unknown";
    }
  }

  wireType(scalar: Scalar, encodingTarget: ModelProperty | Scalar): string {
    const schema = this.schema(scalar, encodingTarget);
    if (!isSchemaObject(schema)) return "never";
    const type = schema.type;
    if (type === "string") return "string";
    if (type === "number" || type === "integer") return "number";
    if (type === "boolean") return "boolean";
    if (type === "null") return "null";
    return "unknown";
  }

  schema(scalar: Scalar, encodingTarget: ModelProperty | Scalar): JsonSchema {
    const intrinsic = this.intrinsicName(scalar);
    const declaredEncode = this.effectiveEncoding(scalar, encodingTarget);
    if (
      this.options.canonicalJsonWire &&
      declaredEncode &&
      !this.validateCanonicalProtocolEncoding(scalar, declaredEncode, encodingTarget)
    ) {
      return false;
    }
    const encode = this.options.canonicalJsonWire ? undefined : declaredEncode;
    const wireIntrinsic = encode ? this.intrinsicName(encode.type) : undefined;
    const encodedAsString = wireIntrinsic === "string";
    const declaredAsString =
      declaredEncode !== undefined && this.intrinsicName(declaredEncode.type) === "string";

    if (BIGINT_INTRINSICS.has(intrinsic)) {
      if (this.isJsonSafeIntegerRange(scalar, encodingTarget) && !encodedAsString) {
        return { type: "integer" };
      }
      if (encodedAsString || (this.options.canonicalJsonWire && declaredAsString)) {
        return {
          type: "string",
          pattern: intrinsic === "uint64" ? "^(?:0|[1-9]\\d*)$" : "^-?(?:0|[1-9]\\d*)$",
        };
      }
      this.options.report(
        "unsafe-number",
        `${intrinsic} must use @encode(string) because JSON number parsing cannot preserve its full range.`,
        encodingTarget,
      );
      return false;
    }
    if (DECIMAL_INTRINSICS.has(intrinsic)) {
      if (!encodedAsString && !(this.options.canonicalJsonWire && declaredAsString)) {
        this.options.report(
          "unsafe-number",
          `${intrinsic} must use @encode(string) so JSON decoding does not lose decimal precision.`,
          encodingTarget,
        );
        return false;
      }
      return { type: "string", pattern: "^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?$" };
    }
    if (encodedAsString && NUMBER_INTRINSICS.has(intrinsic)) {
      const integer = !FLOAT_INTRINSICS.has(intrinsic);
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
          this.options.report(
            "unsupported-encoding",
            `Bytes encoding ${JSON.stringify(encoding)} is not supported by the JSON wire plan.`,
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
          this.options.report(
            "unsupported-encoding",
            `Date/time encoding ${JSON.stringify(encode.encoding)} is not supported by the canonical JSON wire plan.`,
            encodingTarget,
          );
          return false;
        }
        return { type: "string", format: "date-time" };
      case "duration":
        if (encode && encode.encoding && encode.encoding !== "ISO8601") {
          this.options.report(
            "unsupported-encoding",
            `Duration encoding ${JSON.stringify(encode.encoding)} is not supported by the canonical JSON wire plan.`,
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
        if (scalar.baseScalar) return this.schema(scalar.baseScalar, encodingTarget);
        this.options.report(
          "unsupported-type",
          `Scalar ${scalar.name} has no supported TypeSpec intrinsic base.`,
          scalar,
        );
        return {};
    }
  }

  codec(scalar: Scalar, encodingTarget: ModelProperty | Scalar): ValueCodecSpec {
    const intrinsic = this.intrinsicName(scalar);
    const declaredEncode = this.effectiveEncoding(scalar, encodingTarget);
    const encode = this.options.canonicalJsonWire ? undefined : declaredEncode;
    const wireIntrinsic = encode ? this.intrinsicName(encode.type) : undefined;
    const encodedAsString = wireIntrinsic === "string";
    const declaredAsString =
      declaredEncode !== undefined && this.intrinsicName(declaredEncode.type) === "string";
    if (
      BIGINT_INTRINSICS.has(intrinsic) &&
      this.isJsonSafeIntegerRange(scalar, encodingTarget) &&
      !encodedAsString
    ) {
      return { kind: "bigint-number" };
    }
    if (
      BIGINT_INTRINSICS.has(intrinsic) &&
      (encodedAsString || (this.options.canonicalJsonWire && declaredAsString))
    ) {
      return { kind: "bigint-string" };
    }
    if (
      DECIMAL_INTRINSICS.has(intrinsic) &&
      (encodedAsString || (this.options.canonicalJsonWire && declaredAsString))
    ) {
      return { kind: "decimal-string" };
    }
    if (encodedAsString && NUMBER_INTRINSICS.has(intrinsic)) {
      return {
        kind: "number-string",
        integer: !FLOAT_INTRINSICS.has(intrinsic),
      };
    }
    if (intrinsic === "boolean" && encodedAsString) return { kind: "boolean-string" };
    if (intrinsic === "bytes") {
      const encoding = encode?.encoding === "base64url" ? "base64url" : "base64";
      return { kind: "bytes", encoding };
    }
    const dateTimeCodec = this.dateTimeCodec(intrinsic);
    if (dateTimeCodec) return dateTimeCodec;
    if (scalar.baseScalar && !this.program.checker.isStdType(scalar)) {
      return this.codec(scalar.baseScalar, encodingTarget);
    }
    if (intrinsic === "string" || intrinsic === "url") {
      return { kind: "primitive", type: "string" };
    }
    if (intrinsic === "boolean") return { kind: "primitive", type: "boolean" };
    if (NUMBER_INTRINSICS.has(intrinsic)) {
      return { kind: "primitive", type: "number" };
    }
    return { kind: "identity" };
  }

  defaultValueToJson(
    value: ScalarDefaultValue,
    { scalar, encodingTarget }: ScalarDefaultContext,
  ): unknown {
    switch (value.valueKind) {
      case "BooleanValue":
        return this.usesDeclaredStringEncoding(scalar, encodingTarget)
          ? String(value.value)
          : value.value;
      case "NumericValue":
        if (this.numericDefaultUsesString(scalar, encodingTarget)) {
          return value.value.toString();
        }
        return value.value.asNumber() ?? value.value.toString();
      case "ScalarValue": {
        // Only standard date/time constructors have an unambiguous JSON representation.
        // Opaque constructors must not silently inherit their first argument's wire shape.
        const intrinsic = this.intrinsicName(value.scalar);
        if (value.value.name !== "fromISO" || !DATE_TIME_INTRINSICS.has(intrinsic)) {
          return undefined;
        }
        const resolvedScalar = scalar ?? value.scalar;
        const target = encodingTarget ?? resolvedScalar;
        return serializeValueAsJson(
          this.program,
          value,
          resolvedScalar,
          this.options.canonicalJsonWire
            ? undefined
            : this.effectiveEncoding(resolvedScalar, target),
        );
      }
    }
  }

  private effectiveEncoding(
    scalar: Scalar,
    target: ModelProperty | Scalar,
  ): EncodeData | undefined {
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

  private isJsonSafeIntegerRange(scalar: Scalar, target: ModelProperty | Scalar): boolean {
    const scalarMinimum =
      target === scalar
        ? undefined
        : (getMinValueAsNumeric(this.program, scalar) ??
          getMinValueExclusiveAsNumeric(this.program, scalar));
    const scalarMaximum =
      target === scalar
        ? undefined
        : (getMaxValueAsNumeric(this.program, scalar) ??
          getMaxValueExclusiveAsNumeric(this.program, scalar));
    const minimum =
      getMinValueAsNumeric(this.program, target) ??
      getMinValueExclusiveAsNumeric(this.program, target) ??
      scalarMinimum;
    const maximum =
      getMaxValueAsNumeric(this.program, target) ??
      getMaxValueExclusiveAsNumeric(this.program, target) ??
      scalarMaximum;
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

  private validateCanonicalProtocolEncoding(
    scalar: Scalar,
    encode: EncodeData,
    target: ModelProperty | Scalar,
  ): boolean {
    const semantic = this.intrinsicName(scalar);
    const wire = this.intrinsicName(encode.type);
    const encoding = encode.encoding;
    if (this.isCanonicalEncodingSupported(semantic, wire, encoding)) return true;
    this.options.report(
      "unsupported-encoding",
      `Scalar encoding ${JSON.stringify(encoding ?? "string")} is not supported for ${semantic} encoded as ${wire}.`,
      target,
    );
    return false;
  }

  private usesDeclaredStringEncoding(
    scalar: Scalar | undefined,
    target: ModelProperty | Scalar | undefined,
  ): boolean {
    if (this.options.canonicalJsonWire || !scalar || !target) return false;
    const encoding = this.effectiveEncoding(scalar, target);
    return encoding !== undefined && this.intrinsicName(encoding.type) === "string";
  }

  private numericDefaultUsesString(
    scalar: Scalar | undefined,
    target: ModelProperty | Scalar | undefined,
  ): boolean {
    if (!scalar || !target) return false;
    if (!this.options.canonicalJsonWire) {
      return this.usesDeclaredStringEncoding(scalar, target);
    }
    const intrinsic = this.intrinsicName(scalar);
    return (
      DECIMAL_INTRINSICS.has(intrinsic) ||
      (BIGINT_INTRINSICS.has(intrinsic) && !this.isJsonSafeIntegerRange(scalar, target))
    );
  }

  private isCanonicalEncodingSupported(
    semantic: string,
    wire: string,
    encoding: EncodeData["encoding"],
  ): boolean {
    switch (encoding) {
      case undefined:
        return wire === "string" && (semantic === "boolean" || NUMERIC_INTRINSICS.has(semantic));
      case "rfc3339":
      case "rfc7231":
        return wire === "string" && (semantic === "utcDateTime" || semantic === "offsetDateTime");
      case "unixTimestamp":
        return semantic === "utcDateTime" && INTEGER_INTRINSICS.has(wire);
      case "ISO8601":
        return semantic === "duration" && wire === "string";
      case "seconds":
      case "milliseconds":
        return semantic === "duration" && NUMERIC_INTRINSICS.has(wire);
      case "base64":
      case "base64url":
        return semantic === "bytes" && wire === "string";
      default:
        return false;
    }
  }

  private dateTimeCodec(intrinsic: string): ValueCodecSpec | undefined {
    switch (intrinsic) {
      case "plainDate":
        return this.createDateTimeCodec("date", "plain-date");
      case "plainTime":
        return this.createDateTimeCodec("time", "plain-time");
      case "utcDateTime":
        return this.createDateTimeCodec("date-time", "instant");
      case "offsetDateTime":
        return this.createDateTimeCodec("date-time", "zoned-date-time");
      case "duration":
        return this.createDateTimeCodec("duration", "duration");
      default:
        return undefined;
    }
  }

  private createDateTimeCodec(
    format: "date" | "time" | "date-time" | "duration",
    temporalKind: "plain-date" | "plain-time" | "instant" | "zoned-date-time" | "duration",
  ): ValueCodecSpec {
    const representation = this.options.datetimeMode ?? "string";
    if (representation === "temporal") {
      return { kind: "date-time", representation, format, temporalKind };
    }
    return { kind: "date-time", representation, format };
  }
}

function isSchemaObject(schema: JsonSchema): schema is Record<string, unknown> {
  return typeof schema === "object" && schema !== null;
}
