import type { ModelProperty, Scalar } from "@typespec/compiler";
import {
  getEffectiveScalarEncoding,
  getScalarEncodingIssue,
} from "@typespex/compiler-core/unstable";
import type { EmitterCtx } from "./ctx.js";
import { emitDateTimeDecoder, emitDateTimeSerializer } from "./datetime-mode.js";
import { getIntrinsicScalarName } from "./scalar-map.js";
import { decodedTypeKind, emitValidatorsForTarget } from "./validation-emission.js";

export type ScalarEncodingKind =
  | "number-string"
  | "bigint-string"
  | "boolean-string"
  | "rfc3339"
  | "rfc7231"
  | "unix-timestamp"
  | "duration-iso8601"
  | "duration-seconds"
  | "duration-milliseconds"
  | "base64"
  | "base64url";

export type ScalarEncodingContext = "value" | "text" | "header" | "binary";

export interface ScalarEncodingPlan {
  readonly kind: ScalarEncodingKind;
  readonly semanticType: Scalar;
  readonly wireType: Scalar;
  readonly source: Scalar | ModelProperty;
  readonly encoding: string;
}

export type ScalarEncodingResolution =
  | { readonly status: "none" }
  | { readonly status: "supported"; readonly plan: ScalarEncodingPlan }
  | {
      readonly status: "unsupported";
      readonly source: Scalar | ModelProperty;
      readonly encoding: string;
      readonly reason: string;
    };

/** Resolve property overrides first, then the nearest encoding in the scalar inheritance chain. */
export function resolveScalarEncoding(
  ctx: EmitterCtx,
  scalar: Scalar,
  target?: ModelProperty,
  context: ScalarEncodingContext = "value",
): ScalarEncodingResolution {
  const effective = getEffectiveScalarEncoding(ctx.program, scalar, target);
  if (!effective) return resolveDefaultEncoding(ctx, scalar, context);

  const semanticName = getIntrinsicScalarName(scalar);
  const wireName = getIntrinsicScalarName(effective.data.type);
  const encoding = effective.data.encoding ?? "string";
  const supported = resolveSupportedKind(semanticName, wireName, effective.data.encoding);
  if ("reason" in supported) {
    return {
      status: "unsupported",
      source: effective.source,
      encoding,
      reason: supported.reason,
    };
  }
  return {
    status: "supported",
    plan: {
      kind: supported.kind,
      semanticType: scalar,
      wireType: effective.data.type,
      source: effective.source,
      encoding,
    },
  };
}

/** Decoder expression that converts the declared wire scalar to the handler scalar. */
export function emitScalarEncodingDecoder(
  ctx: EmitterCtx,
  plan: ScalarEncodingPlan,
  wireDecoder: string,
): string {
  switch (plan.kind) {
    case "number-string": {
      const shape = numericScalarShape(plan.semanticType);
      const decoder = shape?.integer
        ? "Decoders.encodedIntegerString"
        : "Decoders.encodedNumberString";
      return applyIntrinsicScalarRange(
        `Decoders.compose(${wireDecoder}, ${decoder})`,
        plan.semanticType,
      );
    }
    case "bigint-string":
      return applyIntrinsicScalarRange(
        `Decoders.compose(${wireDecoder}, Decoders.encodedBigIntString)`,
        plan.semanticType,
      );
    case "boolean-string":
      return `Decoders.compose(${wireDecoder}, Decoders.encodedBooleanString)`;
    case "rfc3339":
      return emitDateTimeDecoder(
        ctx,
        plan.semanticType,
        `Decoders.compose(${wireDecoder}, Decoders.rfc3339DateTime)`,
      );
    case "rfc7231":
      return emitDateTimeDecoder(
        ctx,
        plan.semanticType,
        `Decoders.compose(${wireDecoder}, Decoders.rfc7231DateTime)`,
      );
    case "unix-timestamp":
      return emitDateTimeDecoder(ctx, plan.semanticType, `Decoders.unixTimestamp(${wireDecoder})`);
    case "duration-iso8601":
      return emitDateTimeDecoder(
        ctx,
        plan.semanticType,
        `Decoders.compose(${wireDecoder}, Decoders.isoDuration)`,
      );
    case "duration-seconds":
      return emitDateTimeDecoder(
        ctx,
        plan.semanticType,
        `Decoders.numericDuration(${wireDecoder}, "seconds")`,
      );
    case "duration-milliseconds":
      return emitDateTimeDecoder(
        ctx,
        plan.semanticType,
        `Decoders.numericDuration(${wireDecoder}, "milliseconds")`,
      );
    case "base64":
      return `Decoders.compose(${wireDecoder}, Decoders.strictBytes)`;
    case "base64url":
      return `Decoders.compose(${wireDecoder}, Decoders.base64UrlBytes)`;
  }
}

/** JsonSerializer expression that converts a handler scalar to its declared wire scalar. */
export function emitScalarEncodingSerializer(ctx: EmitterCtx, plan: ScalarEncodingPlan): string {
  let serializer: string;
  switch (plan.kind) {
    case "number-string":
      serializer = `JsonSerializers.encodedNumberString(${numericWireOptionsExpression(plan.semanticType)})`;
      break;
    case "bigint-string":
      serializer = `JsonSerializers.encodedBigIntString(${numericWireOptionsExpression(plan.semanticType)})`;
      break;
    case "boolean-string":
      serializer = "JsonSerializers.encodedBooleanString";
      break;
    case "rfc3339":
      serializer = "JsonSerializers.rfc3339DateTime";
      break;
    case "rfc7231":
      serializer = "JsonSerializers.rfc7231DateTime";
      break;
    case "unix-timestamp":
      serializer = `JsonSerializers.unixTimestamp(${numericWireOptionsExpression(plan.wireType)})`;
      break;
    case "duration-iso8601":
      serializer = "JsonSerializers.isoDuration";
      break;
    case "duration-seconds":
      serializer = `JsonSerializers.numericDuration("seconds", ${numericWireOptionsExpression(plan.wireType)})`;
      break;
    case "duration-milliseconds":
      serializer = `JsonSerializers.numericDuration("milliseconds", ${numericWireOptionsExpression(plan.wireType)})`;
      break;
    case "base64":
      serializer = "JsonSerializers.base64Bytes";
      break;
    case "base64url":
      serializer = "JsonSerializers.base64UrlBytes";
      break;
  }

  const validators = emitValidatorsForTarget(
    ctx,
    plan.wireType,
    decodedTypeKind(ctx, plan.wireType),
  );
  const validated =
    validators.length > 0
      ? `JsonSerializers.validate(${serializer}, ${validators.join(", ")})`
      : serializer;
  return emitDateTimeSerializer(ctx, plan.semanticType, validated);
}

interface NumericScalarShape {
  readonly bigint: boolean;
  readonly integer: boolean;
  readonly min?: string;
  readonly max?: string;
}

export function numericScalarShape(scalar: Scalar): NumericScalarShape | undefined {
  switch (getIntrinsicScalarName(scalar)) {
    case "int8":
      return { bigint: false, integer: true, min: "-128", max: "127" };
    case "uint8":
      return { bigint: false, integer: true, min: "0", max: "255" };
    case "int16":
      return { bigint: false, integer: true, min: "-32768", max: "32767" };
    case "uint16":
      return { bigint: false, integer: true, min: "0", max: "65535" };
    case "int32":
      return { bigint: false, integer: true, min: "-2147483648", max: "2147483647" };
    case "uint32":
      return { bigint: false, integer: true, min: "0", max: "4294967295" };
    case "int64":
      return {
        bigint: true,
        integer: true,
        min: "-9223372036854775808n",
        max: "9223372036854775807n",
      };
    case "uint64":
      return {
        bigint: true,
        integer: true,
        min: "0n",
        max: "18446744073709551615n",
      };
    case "integer":
    case "safeint":
      return { bigint: false, integer: true };
    case "float32":
    case "float64":
    case "float":
    case "numeric":
    case "decimal":
    case "decimal128":
      return { bigint: false, integer: false };
    default:
      return undefined;
  }
}

function resolveDefaultEncoding(
  ctx: EmitterCtx,
  scalar: Scalar,
  context: ScalarEncodingContext,
): ScalarEncodingResolution {
  if (context === "binary") return { status: "none" };
  const semanticName = getIntrinsicScalarName(scalar);
  let kind: ScalarEncodingKind;
  let encoding: string;
  switch (semanticName) {
    case "utcDateTime":
    case "offsetDateTime":
      kind = context === "header" ? "rfc7231" : "rfc3339";
      encoding = kind;
      break;
    case "duration":
      kind = "duration-iso8601";
      encoding = "ISO8601";
      break;
    case "bytes":
      if (context !== "text") return { status: "none" };
      kind = "base64";
      encoding = "base64";
      break;
    default:
      return { status: "none" };
  }

  return {
    status: "supported",
    plan: {
      kind,
      semanticType: scalar,
      wireType: ctx.program.checker.getStdType("string"),
      source: scalar,
      encoding,
    },
  };
}

function resolveSupportedKind(
  semanticName: string,
  wireName: string,
  encoding: string | undefined,
): { readonly kind: ScalarEncodingKind } | { readonly reason: string } {
  const reason = getScalarEncodingIssue(semanticName, wireName, encoding);
  if (reason !== undefined) return { reason };

  switch (encoding) {
    case undefined:
      if (semanticName === "boolean") return { kind: "boolean-string" };
      if (semanticName === "int64" || semanticName === "uint64") return { kind: "bigint-string" };
      return { kind: "number-string" };
    case "rfc3339":
    case "rfc7231":
    case "base64":
    case "base64url":
      return { kind: encoding };
    case "unixTimestamp":
      return { kind: "unix-timestamp" };
    case "ISO8601":
      return { kind: "duration-iso8601" };
    case "seconds":
      return { kind: "duration-seconds" };
    case "milliseconds":
      return { kind: "duration-milliseconds" };
    default:
      return { reason: `custom encoding ${JSON.stringify(encoding)} is not supported` };
  }
}

function applyIntrinsicScalarRange(expression: string, scalar: Scalar): string {
  const shape = numericScalarShape(scalar);
  if (!shape?.min && !shape?.max) return expression;
  const validators: string[] = [];
  if (shape.min) validators.push(`Validators.minValue(${shape.min})`);
  if (shape.max) validators.push(`Validators.maxValue(${shape.max})`);
  return `${expression}.validate(${validators.join(", ")})`;
}

function numericWireOptionsExpression(scalar: Scalar): string {
  const shape = numericScalarShape(scalar);
  if (!shape) return "{}";
  const fields: string[] = [];
  if (shape.bigint) fields.push("bigint: true");
  if (shape.integer) fields.push("integer: true");
  if (shape.min) fields.push(`min: ${shape.min}`);
  if (shape.max) fields.push(`max: ${shape.max}`);
  return `{ ${fields.join(", ")} }`;
}
