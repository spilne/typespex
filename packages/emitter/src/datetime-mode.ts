import type { Scalar } from "@typespec/compiler";
import type { EmitterCtx } from "./ctx.js";
import { tsLiteral } from "./typescript-names.js";
import type { TypespexEmitterOptions } from "./lib.js";

export type DateTimeMode = NonNullable<TypespexEmitterOptions["datetime-mode"]>;

const TEMPORAL_PACKAGE = "@js-temporal/polyfill";
const DATE_TIME_SCALAR_NAMES = new Set([
  "plainDate",
  "plainTime",
  "utcDateTime",
  "offsetDateTime",
  "duration",
]);

export function getDateTimeMode(ctx: EmitterCtx): DateTimeMode {
  return ctx.options["datetime-mode"] ?? "string";
}

export function dateTimeHandlerType(scalar: Scalar, mode: DateTimeMode): string | undefined {
  const name = getDateTimeIntrinsicName(scalar);
  if (mode === "date") {
    return name === "utcDateTime" || name === "offsetDateTime" ? "Date" : undefined;
  }
  if (mode !== "temporal") return undefined;

  switch (name) {
    case "plainDate":
      return "Temporal.PlainDate";
    case "plainTime":
      return "Temporal.PlainTime";
    case "utcDateTime":
      return "Temporal.Instant";
    case "offsetDateTime":
      return "Temporal.ZonedDateTime";
    case "duration":
      return "Temporal.Duration";
    default:
      return undefined;
  }
}

export function dateTimeScalarNeedsTransform(ctx: EmitterCtx, scalar: Scalar): boolean {
  return dateTimeHandlerType(scalar, getDateTimeMode(ctx)) !== undefined;
}

/** Convert a validated wire string decoder into the configured handler representation. */
export function emitDateTimeDecoder(ctx: EmitterCtx, scalar: Scalar, decoder: string): string {
  const mode = getDateTimeMode(ctx);
  if (!dateTimeHandlerType(scalar, mode)) return decoder;

  const name = getDateTimeIntrinsicName(scalar);
  if (mode === "date") {
    return `Decoders.dateTimeDate(${decoder})`;
  }

  let transform: string;
  switch (name) {
    case "plainDate":
      transform = "(value) => Temporal.PlainDate.from(value)";
      break;
    case "plainTime":
      transform = "(value) => Temporal.PlainTime.from(value)";
      break;
    case "utcDateTime":
      transform =
        '(value) => { if (/-00:00$/.test(value)) throw new TypeError("Temporal mode cannot represent an RFC 3339 date-time with an unknown -00:00 offset."); if (/:60(?:\\.\\d+)?(?:[zZ]|[+-]\\d{2}:\\d{2})$/.test(value)) throw new TypeError("Temporal mode cannot represent an RFC 3339 leap-second date-time."); return Temporal.Instant.from(value); }';
      break;
    case "offsetDateTime":
      transform =
        '(value) => { if (/-00:00$/.test(value)) throw new TypeError("Temporal mode cannot represent an RFC 3339 date-time with an unknown -00:00 offset."); if (/:60(?:\\.\\d+)?(?:[zZ]|[+-]\\d{2}:\\d{2})$/.test(value)) throw new TypeError("Temporal mode cannot represent an RFC 3339 leap-second date-time."); return Temporal.Instant.from(value).toZonedDateTimeISO(/[zZ]$/.test(value) ? "UTC" : value.slice(-6)); }';
      break;
    case "duration":
      transform = "(value) => Temporal.Duration.from(value)";
      break;
    default:
      return decoder;
  }
  return `Decoders.transform(${decoder}, ${transform})`;
}

/** Convert a configured handler value to the validated string serializer's input. */
export function emitDateTimeSerializer(
  ctx: EmitterCtx,
  scalar: Scalar,
  serializer: string,
): string {
  const mode = getDateTimeMode(ctx);
  const handlerType = dateTimeHandlerType(scalar, mode);
  if (!handlerType) return serializer;

  const name = getDateTimeIntrinsicName(scalar);
  if (mode === "date") {
    return `JsonSerializers.transformInput(${serializer}, (value: Date) => Date.prototype.toISOString.call(value))`;
  }

  let transform: string;
  switch (name) {
    case "plainDate":
      transform =
        '(value: Temporal.PlainDate) => Temporal.PlainDate.prototype.withCalendar.call(value, "iso8601").toString()';
      break;
    case "plainTime":
      transform =
        "(value: Temporal.PlainTime) => Temporal.PlainTime.prototype.toString.call(value)";
      break;
    case "utcDateTime":
      transform = "(value: Temporal.Instant) => Temporal.Instant.prototype.toString.call(value)";
      break;
    case "offsetDateTime":
      transform =
        '(value: Temporal.ZonedDateTime) => { const normalized = Temporal.ZonedDateTime.prototype.withCalendar.call(value, "iso8601"); const dateTime = normalized.toPlainDateTime().toString(); return `${dateTime}${normalized.offset === "+00:00" ? "Z" : normalized.offset}`; }';
      break;
    case "duration":
      transform = "(value: Temporal.Duration) => Temporal.Duration.prototype.toString.call(value)";
      break;
    default:
      return serializer;
  }
  return `JsonSerializers.transformInput(${serializer}, ${transform})`;
}

/** Add the direct Temporal dependency only to generated files that reference it. */
export function addTemporalImport(lines: string[], kind: "type" | "value"): void {
  if (!lines.some((line) => line.includes("Temporal."))) return;
  const prefix = kind === "type" ? "import type" : "import";
  lines.splice(2, 0, `${prefix} { Temporal } from ${tsLiteral(TEMPORAL_PACKAGE)};`);
}

function getDateTimeIntrinsicName(scalar: Scalar): string | undefined {
  let current: Scalar | undefined = scalar;
  while (current) {
    if (current.namespace?.name === "TypeSpec" && DATE_TIME_SCALAR_NAMES.has(current.name)) {
      return current.name;
    }
    current = current.baseScalar;
  }
  return undefined;
}
