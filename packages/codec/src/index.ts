export { bytesToBase64 } from "./base64.js";
export {
  ScalarEncodings,
  type DurationNumericUnit,
  type NumericWireEncoding,
} from "./scalar-encoding.js";

/** A path-aware issue produced while converting between wire and semantic values. */
export interface CodecIssue {
  readonly message: string;
  readonly path: readonly (string | number)[];
}

export type CodecResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly CodecIssue[] };

export type DateTimeRepresentation = "string" | "date" | "temporal";

export type ValueCodecSpec =
  | { readonly kind: "identity" }
  | { readonly kind: "primitive"; readonly type: "string" | "number" | "boolean" | "null" }
  | { readonly kind: "literal"; readonly value: string | number | boolean | null }
  | { readonly kind: "bigint-string" }
  | { readonly kind: "bigint-literal-string"; readonly value: string }
  | { readonly kind: "bigint-number" }
  | { readonly kind: "decimal-string" }
  | { readonly kind: "number-string"; readonly integer?: boolean }
  | { readonly kind: "boolean-string" }
  | { readonly kind: "bytes"; readonly encoding?: "base64" | "base64url" }
  | {
      readonly kind: "date-time";
      readonly representation: DateTimeRepresentation;
      readonly format: "date" | "time" | "date-time" | "duration";
      readonly temporalKind?:
        | "plain-date"
        | "plain-time"
        | "instant"
        | "zoned-date-time"
        | "duration";
    }
  | { readonly kind: "array"; readonly item: ValueCodecSpec }
  | { readonly kind: "tuple"; readonly items: readonly ValueCodecSpec[] }
  | {
      readonly kind: "object";
      readonly properties: Readonly<Record<string, ObjectPropertyCodecSpec>>;
      readonly additionalProperties?: ValueCodecSpec | true;
    }
  | { readonly kind: "union"; readonly variants: readonly ValueCodecSpec[] }
  | { readonly kind: "ref"; readonly name: string }
  | { readonly kind: "file" };

export interface ObjectPropertyCodecSpec {
  readonly wireName: string;
  readonly codec: ValueCodecSpec;
  readonly optional?: boolean;
  readonly hasDefault?: boolean;
  readonly defaultValue?: unknown;
}

export interface ValueCodecDocument {
  readonly root: ValueCodecSpec;
  readonly definitions?: Readonly<Record<string, ValueCodecSpec>>;
}

export interface ValueCodec<T> {
  decode(input: unknown): Promise<CodecResult<T>>;
  encode(value: T): Promise<CodecResult<unknown>>;
}

const MAX_CODEC_DEPTH = 256;

/**
 * Creates a protocol-neutral codec from a generated, data-only description.
 * JSON Schema remains responsible for contract validation; this codec performs
 * path-aware structural checks as a defense in depth and applies wire transforms.
 */
export function createValueCodec<T>(document: ValueCodecDocument): ValueCodec<T> {
  const definitions = document.definitions ?? {};

  return {
    async decode(input: unknown): Promise<CodecResult<T>> {
      return (await decodeValue(document.root, input, definitions, [], 0)) as CodecResult<T>;
    },
    async encode(value: T): Promise<CodecResult<unknown>> {
      return encodeValue(document.root, value, definitions, [], 0);
    },
  };
}

async function decodeValue(
  spec: ValueCodecSpec,
  input: unknown,
  definitions: Readonly<Record<string, ValueCodecSpec>>,
  path: readonly (string | number)[],
  depth: number,
): Promise<CodecResult<unknown>> {
  if (depth > MAX_CODEC_DEPTH) return failure(path, "Codec nesting limit exceeded.");

  switch (spec.kind) {
    case "identity":
      return success(input);
    case "primitive":
      return primitiveMatches(input, spec.type)
        ? success(input)
        : failure(path, `Expected a ${spec.type} value.`);
    case "literal":
      return Object.is(input, spec.value)
        ? success(input)
        : failure(path, `Expected the literal ${JSON.stringify(spec.value)}.`);
    case "bigint-string":
      if (typeof input !== "string" || !/^-?(?:0|[1-9]\d*)$/.test(input)) {
        return failure(path, "Expected an integer encoded as a decimal string.");
      }
      try {
        return success(BigInt(input));
      } catch {
        return failure(path, "Expected a valid integer encoded as a decimal string.");
      }
    case "bigint-literal-string":
      if (input !== spec.value) {
        return failure(path, `Expected the integer string ${JSON.stringify(spec.value)}.`);
      }
      try {
        return success(BigInt(spec.value));
      } catch {
        return failure(path, "Codec plan contains an invalid bigint literal.");
      }
    case "bigint-number":
      return typeof input === "number" && Number.isSafeInteger(input)
        ? success(BigInt(input))
        : failure(path, "Expected a safe JSON integer.");
    case "decimal-string":
      return typeof input === "string" &&
        /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(input)
        ? success(input)
        : failure(path, "Expected a decimal encoded as a string.");
    case "number-string": {
      if (
        typeof input !== "string" ||
        !(
          spec.integer ? /^-?(?:0|[1-9]\d*)$/ : /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/
        ).test(input)
      ) {
        return failure(
          path,
          `Expected a ${spec.integer ? "integer" : "number"} encoded as a string.`,
        );
      }
      const value = Number(input);
      return Number.isFinite(value) && (!spec.integer || Number.isSafeInteger(value))
        ? success(value)
        : failure(path, "Encoded number is outside the safe JavaScript range.");
    }
    case "boolean-string":
      return input === "true"
        ? success(true)
        : input === "false"
          ? success(false)
          : failure(path, "Expected a boolean encoded as true or false.");
    case "bytes": {
      if (typeof input !== "string") return failure(path, "Expected base64-encoded bytes.");
      try {
        return success(decodeBase64(input, spec.encoding ?? "base64"));
      } catch (error) {
        return failure(path, error instanceof Error ? error.message : String(error));
      }
    }
    case "date-time":
      if (typeof input !== "string") return failure(path, "Expected a date/time string.");
      if (
        spec.representation === "string" ||
        (spec.representation === "date" && spec.format !== "date-time")
      ) {
        return success(input);
      }
      if (spec.representation === "date") {
        const value = new Date(input);
        return Number.isNaN(value.valueOf())
          ? failure(path, "Expected a valid RFC 3339 date/time.")
          : success(value);
      }
      return decodeTemporal(spec, input, path);
    case "array": {
      if (!Array.isArray(input)) return failure(path, "Expected an array.");
      const output: unknown[] = [];
      const issues: CodecIssue[] = [];
      for (let index = 0; index < input.length; index += 1) {
        const result = await decodeValue(
          spec.item,
          input[index],
          definitions,
          [...path, index],
          depth + 1,
        );
        if (result.ok) output.push(result.value);
        else issues.push(...result.issues);
      }
      return issues.length === 0 ? success(output) : { ok: false, issues };
    }
    case "tuple": {
      if (!Array.isArray(input) || input.length !== spec.items.length) {
        return failure(path, `Expected a tuple with ${spec.items.length} items.`);
      }
      const output: unknown[] = [];
      const issues: CodecIssue[] = [];
      for (let index = 0; index < spec.items.length; index += 1) {
        const result = await decodeValue(
          spec.items[index]!,
          input[index],
          definitions,
          [...path, index],
          depth + 1,
        );
        if (result.ok) output.push(result.value);
        else issues.push(...result.issues);
      }
      return issues.length === 0 ? success(output) : { ok: false, issues };
    }
    case "object":
      return decodeObject(spec, input, definitions, path, depth);
    case "union": {
      const failures: CodecIssue[][] = [];
      for (const variant of spec.variants) {
        const result = await decodeValue(variant, input, definitions, path, depth + 1);
        if (result.ok) return result;
        failures.push([...result.issues]);
      }
      return {
        ok: false,
        issues:
          failures.length === 0
            ? [{ path, message: "No union variant is defined." }]
            : failures.reduce((smallest, current) =>
                current.length < smallest.length ? current : smallest,
              ),
      };
    }
    case "ref": {
      const target = definitions[spec.name];
      return target
        ? decodeValue(target, input, definitions, path, depth + 1)
        : failure(path, `Unknown codec reference ${JSON.stringify(spec.name)}.`);
    }
    case "file":
      return decodeFile(input, path);
  }
}

async function encodeValue(
  spec: ValueCodecSpec,
  value: unknown,
  definitions: Readonly<Record<string, ValueCodecSpec>>,
  path: readonly (string | number)[],
  depth: number,
): Promise<CodecResult<unknown>> {
  if (depth > MAX_CODEC_DEPTH) return failure(path, "Codec nesting limit exceeded.");

  switch (spec.kind) {
    case "identity":
      return success(value);
    case "primitive":
      return primitiveMatches(value, spec.type)
        ? success(value)
        : failure(path, `Expected a ${spec.type} value.`);
    case "literal":
      return Object.is(value, spec.value)
        ? success(value)
        : failure(path, `Expected the literal ${JSON.stringify(spec.value)}.`);
    case "bigint-string":
      return typeof value === "bigint"
        ? success(value.toString())
        : failure(path, "Expected a bigint semantic value.");
    case "bigint-literal-string":
      return typeof value === "bigint" && value.toString() === spec.value
        ? success(spec.value)
        : failure(path, `Expected the bigint literal ${spec.value}n.`);
    case "bigint-number":
      if (typeof value !== "bigint") return failure(path, "Expected a bigint semantic value.");
      if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        return failure(path, "Bigint semantic value is outside the safe JSON integer range.");
      }
      return success(Number(value));
    case "decimal-string":
      return typeof value === "string" &&
        /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)
        ? success(value)
        : failure(path, "Expected a decimal semantic string.");
    case "number-string":
      return typeof value === "number" &&
        Number.isFinite(value) &&
        (!spec.integer || Number.isSafeInteger(value))
        ? success(String(value))
        : failure(path, `Expected a finite ${spec.integer ? "integer" : "number"} semantic value.`);
    case "boolean-string":
      return typeof value === "boolean"
        ? success(String(value))
        : failure(path, "Expected a boolean semantic value.");
    case "bytes":
      return value instanceof Uint8Array
        ? success(encodeBase64(value, spec.encoding ?? "base64"))
        : failure(path, "Expected a Uint8Array semantic value.");
    case "date-time":
      return encodeDateTime(spec, value, path);
    case "array": {
      if (!Array.isArray(value)) return failure(path, "Expected an array.");
      const output: unknown[] = [];
      const issues: CodecIssue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const result = await encodeValue(
          spec.item,
          value[index],
          definitions,
          [...path, index],
          depth + 1,
        );
        if (result.ok) output.push(result.value);
        else issues.push(...result.issues);
      }
      return issues.length === 0 ? success(output) : { ok: false, issues };
    }
    case "tuple": {
      if (!Array.isArray(value) || value.length !== spec.items.length) {
        return failure(path, `Expected a tuple with ${spec.items.length} items.`);
      }
      const output: unknown[] = [];
      const issues: CodecIssue[] = [];
      for (let index = 0; index < spec.items.length; index += 1) {
        const result = await encodeValue(
          spec.items[index]!,
          value[index],
          definitions,
          [...path, index],
          depth + 1,
        );
        if (result.ok) output.push(result.value);
        else issues.push(...result.issues);
      }
      return issues.length === 0 ? success(output) : { ok: false, issues };
    }
    case "object":
      return encodeObject(spec, value, definitions, path, depth);
    case "union": {
      const failures: CodecIssue[][] = [];
      for (const variant of spec.variants) {
        const result = await encodeValue(variant, value, definitions, path, depth + 1);
        if (result.ok) return result;
        failures.push([...result.issues]);
      }
      return {
        ok: false,
        issues:
          failures.length === 0
            ? [{ path, message: "No union variant is defined." }]
            : failures.reduce((smallest, current) =>
                current.length < smallest.length ? current : smallest,
              ),
      };
    }
    case "ref": {
      const target = definitions[spec.name];
      return target
        ? encodeValue(target, value, definitions, path, depth + 1)
        : failure(path, `Unknown codec reference ${JSON.stringify(spec.name)}.`);
    }
    case "file":
      return encodeFile(value, path);
  }
}

async function decodeObject(
  spec: Extract<ValueCodecSpec, { kind: "object" }>,
  input: unknown,
  definitions: Readonly<Record<string, ValueCodecSpec>>,
  path: readonly (string | number)[],
  depth: number,
): Promise<CodecResult<unknown>> {
  if (!isPlainObject(input)) return failure(path, "Expected a plain object.");
  const output: Record<string, unknown> = {};
  const issues = duplicateWireNameIssues(spec, path);
  const knownWireNames = new Set<string>();
  const knownSemanticNames = new Set(Object.keys(spec.properties));

  for (const [propertyName, property] of Object.entries(spec.properties)) {
    knownWireNames.add(property.wireName);
    if (!Object.prototype.hasOwnProperty.call(input, property.wireName)) {
      if (property.hasDefault) {
        const decodedDefault = await decodeValue(
          property.codec,
          property.defaultValue,
          definitions,
          [...path, property.wireName],
          depth + 1,
        );
        if (decodedDefault.ok) defineDataProperty(output, propertyName, decodedDefault.value);
        else issues.push(...decodedDefault.issues);
      } else if (!property.optional) {
        issues.push({
          path: [...path, property.wireName],
          message: "Required property is missing.",
        });
      }
      continue;
    }

    const decoded = await decodeValue(
      property.codec,
      input[property.wireName],
      definitions,
      [...path, property.wireName],
      depth + 1,
    );
    if (decoded.ok) defineDataProperty(output, propertyName, decoded.value);
    else issues.push(...decoded.issues);
  }

  for (const [wireName, wireValue] of Object.entries(input)) {
    if (knownWireNames.has(wireName)) continue;
    if (spec.additionalProperties === undefined) continue;
    if (knownSemanticNames.has(wireName)) {
      issues.push({
        path: [...path, wireName],
        message: "Additional wire property collides with a declared semantic property.",
      });
      continue;
    }
    if (spec.additionalProperties === true) {
      defineDataProperty(output, wireName, wireValue);
    } else if (spec.additionalProperties) {
      const decoded = await decodeValue(
        spec.additionalProperties,
        wireValue,
        definitions,
        [...path, wireName],
        depth + 1,
      );
      if (decoded.ok) defineDataProperty(output, wireName, decoded.value);
      else issues.push(...decoded.issues);
    }
  }

  return issues.length === 0 ? success(output) : { ok: false, issues };
}

async function encodeObject(
  spec: Extract<ValueCodecSpec, { kind: "object" }>,
  value: unknown,
  definitions: Readonly<Record<string, ValueCodecSpec>>,
  path: readonly (string | number)[],
  depth: number,
): Promise<CodecResult<unknown>> {
  if (!isPlainObject(value)) return failure(path, "Expected a plain object.");
  const output: Record<string, unknown> = {};
  const issues = duplicateWireNameIssues(spec, path);
  const knownProperties = new Set(Object.keys(spec.properties));
  const knownWireNames = new Set(
    Object.values(spec.properties).map((property) => property.wireName),
  );

  for (const [propertyName, property] of Object.entries(spec.properties)) {
    if (
      !Object.prototype.hasOwnProperty.call(value, propertyName) ||
      value[propertyName] === undefined
    ) {
      if (!property.optional && !property.hasDefault) {
        issues.push({ path: [...path, propertyName], message: "Required property is missing." });
      }
      continue;
    }
    const encoded = await encodeValue(
      property.codec,
      value[propertyName],
      definitions,
      [...path, propertyName],
      depth + 1,
    );
    if (encoded.ok) defineDataProperty(output, property.wireName, encoded.value);
    else issues.push(...encoded.issues);
  }

  for (const [propertyName, propertyValue] of Object.entries(value)) {
    if (knownProperties.has(propertyName)) continue;
    if (spec.additionalProperties === undefined) continue;
    if (knownWireNames.has(propertyName)) {
      issues.push({
        path: [...path, propertyName],
        message: "Additional semantic property collides with a declared wire property.",
      });
      continue;
    }
    if (spec.additionalProperties === true) {
      defineDataProperty(output, propertyName, propertyValue);
    } else if (spec.additionalProperties) {
      const encoded = await encodeValue(
        spec.additionalProperties,
        propertyValue,
        definitions,
        [...path, propertyName],
        depth + 1,
      );
      if (encoded.ok) defineDataProperty(output, propertyName, encoded.value);
      else issues.push(...encoded.issues);
    }
  }

  return issues.length === 0 ? success(output) : { ok: false, issues };
}

function duplicateWireNameIssues(
  spec: Extract<ValueCodecSpec, { kind: "object" }>,
  path: readonly (string | number)[],
): CodecIssue[] {
  const propertiesByWireName = new Map<string, string>();
  const issues: CodecIssue[] = [];
  for (const [semanticName, property] of Object.entries(spec.properties)) {
    const existing = propertiesByWireName.get(property.wireName);
    if (existing !== undefined) {
      issues.push({
        path: [...path, property.wireName],
        message: `Declared properties ${JSON.stringify(existing)} and ${JSON.stringify(semanticName)} share the same wire name.`,
      });
    } else {
      propertiesByWireName.set(property.wireName, semanticName);
    }
  }
  return issues;
}

async function decodeTemporal(
  spec: Extract<ValueCodecSpec, { kind: "date-time" }>,
  input: string,
  path: readonly (string | number)[],
): Promise<CodecResult<unknown>> {
  try {
    const temporal = await resolveTemporal();
    switch (spec.temporalKind) {
      case "plain-date":
        return success(temporal.PlainDate.from(input));
      case "plain-time":
        return success(temporal.PlainTime.from(input));
      case "duration":
        return success(temporal.Duration.from(input));
      case "zoned-date-time": {
        rejectUnsupportedTemporalDateTime(input);
        const zone = /[zZ]$/.test(input) ? "UTC" : input.slice(-6);
        return success(temporal.Instant.from(input).toZonedDateTimeISO(zone));
      }
      case "instant":
      default:
        rejectUnsupportedTemporalDateTime(input);
        return success(temporal.Instant.from(input));
    }
  } catch {
    return failure(path, `Expected a valid Temporal ${spec.temporalKind ?? "instant"} value.`);
  }
}

async function encodeDateTime(
  spec: Extract<ValueCodecSpec, { kind: "date-time" }>,
  value: unknown,
  path: readonly (string | number)[],
): Promise<CodecResult<unknown>> {
  if (
    spec.representation === "string" ||
    (spec.representation === "date" && spec.format !== "date-time")
  ) {
    return typeof value === "string"
      ? success(value)
      : failure(path, "Expected a date/time semantic string.");
  }
  if (spec.representation === "date") {
    return value instanceof Date && !Number.isNaN(value.valueOf())
      ? success(value.toISOString())
      : failure(path, "Expected a valid Date semantic value.");
  }
  try {
    const temporal = await resolveTemporal();
    switch (spec.temporalKind) {
      case "plain-date":
        return value instanceof temporal.PlainDate
          ? success(value.toString())
          : failure(path, "Expected a Temporal.PlainDate semantic value.");
      case "plain-time":
        return value instanceof temporal.PlainTime
          ? success(value.toString())
          : failure(path, "Expected a Temporal.PlainTime semantic value.");
      case "duration":
        return value instanceof temporal.Duration
          ? success(value.toString())
          : failure(path, "Expected a Temporal.Duration semantic value.");
      case "zoned-date-time":
        if (!(value instanceof temporal.ZonedDateTime)) {
          return failure(path, "Expected a Temporal.ZonedDateTime semantic value.");
        }
        return success(
          `${value.toPlainDateTime().toString()}${value.offset === "+00:00" ? "Z" : value.offset}`,
        );
      case "instant":
      default:
        return value instanceof temporal.Instant
          ? success(value.toString())
          : failure(path, "Expected a Temporal.Instant semantic value.");
    }
  } catch {
    return failure(path, "Temporal is unavailable or the semantic value is invalid.");
  }
}

type TemporalApi = typeof import("@js-temporal/polyfill").Temporal;

let temporalPromise: Promise<TemporalApi> | undefined;

async function resolveTemporal(): Promise<TemporalApi> {
  const installed = (globalThis as { Temporal?: TemporalApi }).Temporal;
  if (installed) return installed;
  temporalPromise ??= import("@js-temporal/polyfill").then((module) => module.Temporal);
  return temporalPromise;
}

function rejectUnsupportedTemporalDateTime(value: string): void {
  if (/-00:00$/.test(value) || /:60(?:\.\d+)?(?:[zZ]|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new TypeError("Temporal cannot preserve this RFC 3339 offset or leap second.");
  }
}

function decodeFile(input: unknown, path: readonly (string | number)[]): CodecResult<unknown> {
  if (!isPlainObject(input)) return failure(path, "Expected a file record.");
  if (typeof input.name !== "string" || typeof input.data !== "string") {
    return failure(path, "Expected file fields name and base64 data.");
  }
  if (input.mediaType !== undefined && typeof input.mediaType !== "string") {
    return failure([...path, "mediaType"], "Expected a media type string.");
  }
  if (typeof File !== "function") {
    return failure(path, "The runtime does not provide the Web File API.");
  }
  try {
    const bytes = decodeBase64(input.data, "base64");
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return success(new File([buffer], input.name, { type: input.mediaType ?? "" }));
  } catch (error) {
    return failure(path, error instanceof Error ? error.message : String(error));
  }
}

async function encodeFile(
  value: unknown,
  path: readonly (string | number)[],
): Promise<CodecResult<unknown>> {
  if (typeof File !== "function" || !(value instanceof File)) {
    return failure(path, "Expected a File semantic value.");
  }
  const bytes = new Uint8Array(await value.arrayBuffer());
  return success({
    name: value.name,
    ...(value.type ? { mediaType: value.type } : {}),
    data: encodeBase64(bytes, "base64"),
  });
}

function decodeBase64(value: string, encoding: "base64" | "base64url"): Uint8Array {
  let normalized = value;
  if (encoding === "base64url") {
    normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    normalized += "=".repeat((4 - (normalized.length % 4)) % 4);
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) {
    throw new TypeError(`Expected valid ${encoding} data.`);
  }
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64(value: Uint8Array, encoding: "base64" | "base64url"): string {
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...value.subarray(offset, offset + chunkSize)));
  }
  const encoded = btoa(chunks.join(""));
  return encoding === "base64url"
    ? encoded.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
    : encoded;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function primitiveMatches(
  value: unknown,
  type: Extract<ValueCodecSpec, { kind: "primitive" }>["type"],
): boolean {
  return type === "null" ? value === null : typeof value === type;
}

function defineDataProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function success<T>(value: T): CodecResult<T> {
  return { ok: true, value };
}

function failure(path: readonly (string | number)[], message: string): CodecResult<never> {
  return { ok: false, issues: [{ path, message }] };
}
