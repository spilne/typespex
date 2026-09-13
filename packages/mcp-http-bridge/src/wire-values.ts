import { ScalarEncodings, jsonValuesEqual } from "@typespex/codec";
import type { HttpWireValuePlan } from "@typespex/http-client";
import { McpToolError } from "@typespex/mcp-server";
import { asFileRecord, decodeBase64, encodeBase64 } from "./binary.js";
import { isRecord } from "./value-paths.js";

type Definitions = ReadonlyMap<string, HttpWireValuePlan>;
type WireResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: McpToolError };
type WireCache = WeakMap<object, Map<HttpWireValuePlan, Map<number, WireResult>>>;
type ActiveValues = WeakMap<object, Set<HttpWireValuePlan>>;
class UnionConversionError extends McpToolError {
  constructor(
    message: string,
    readonly reason: "ambiguous" | "invalid-value" | "shape" | "projection" | "coercion",
  ) {
    super(message);
  }
}
interface WireContext {
  readonly definitions: Definitions;
  readonly strictObjects?: boolean;
  readonly allowCoercion?: boolean;
  readonly depth: number;
  readonly completed: Map<Definitions, readonly [WireCache, WireCache, WireCache, WireCache]>;
  readonly active: Map<
    Definitions,
    readonly [ActiveValues, ActiveValues, ActiveValues, ActiveValues]
  >;
}
type Convert = (value: unknown, plan: HttpWireValuePlan, context: WireContext) => unknown;

function rootContext(definitions: Definitions): WireContext {
  return { definitions, depth: 0, completed: new Map(), active: new Map() };
}

export function decodeHttpWireValue(
  value: unknown,
  plan: HttpWireValuePlan,
  definitions: Definitions = new Map(),
): unknown {
  return decodeValue(value, plan, rootContext(definitions));
}

export function encodeHttpWireValue(
  value: unknown,
  plan: HttpWireValuePlan,
  definitions: Definitions = new Map(),
): unknown {
  return encodeValue(value, plan, rootContext(definitions));
}

function decodeValue(value: unknown, plan: HttpWireValuePlan, context: WireContext): unknown {
  return cachedConversion(value, plan, context, decodeUncheckedValue);
}

function encodeValue(value: unknown, plan: HttpWireValuePlan, context: WireContext): unknown {
  return cachedConversion(value, plan, context, encodeUncheckedValue);
}

function cachedConversion(
  value: unknown,
  plan: HttpWireValuePlan,
  context: WireContext,
  convert: Convert,
): unknown {
  if (context.depth > 256) throw new McpToolError("HTTP wire conversion nesting limit exceeded.");
  const next = { ...context, depth: context.depth + 1 };
  if (value === null || typeof value !== "object") return convert(value, plan, next);
  let caches = context.completed.get(context.definitions);
  if (!caches)
    context.completed.set(
      context.definitions,
      (caches = [new WeakMap(), new WeakMap(), new WeakMap(), new WeakMap()]),
    );
  let active = context.active.get(context.definitions);
  if (!active)
    context.active.set(
      context.definitions,
      (active = [new WeakMap(), new WeakMap(), new WeakMap(), new WeakMap()]),
    );
  const mode = ((context.strictObjects ? 2 : 0) + (context.allowCoercion === false ? 1 : 0)) as
    | 0
    | 1
    | 2
    | 3;
  const previous = caches[mode].get(value)?.get(plan)?.get(context.depth);
  if (previous) {
    if (!previous.ok) throw previous.error;
    return previous.value;
  }
  const pending = active[mode].get(value) ?? new Set<HttpWireValuePlan>();
  if (pending.has(plan)) throw new McpToolError("Cyclic values cannot be converted as HTTP JSON.");
  pending.add(plan);
  active[mode].set(value, pending);
  let result: WireResult;
  try {
    result = { ok: true, value: convert(value, plan, next) };
  } catch (error) {
    if (!(error instanceof McpToolError)) throw error;
    result = { ok: false, error };
  } finally {
    pending.delete(plan);
  }
  const completed =
    caches[mode].get(value) ?? new Map<HttpWireValuePlan, Map<number, WireResult>>();
  const depths = completed.get(plan) ?? new Map<number, WireResult>();
  depths.set(context.depth, result);
  completed.set(plan, depths);
  caches[mode].set(value, completed);
  if (!result.ok) throw result.error;
  return result.value;
}

function convertUnion(
  value: unknown,
  plan: Extract<HttpWireValuePlan, { kind: "union" }>,
  context: WireContext,
  convert: Convert,
): unknown {
  let mismatch: UnionConversionError | undefined;
  for (const strictObjects of context.strictObjects ? [true] : [true, false]) {
    let coveredFailure: McpToolError | undefined;
    for (const allowCoercion of context.allowCoercion === false ? [false] : [false, true]) {
      let match: { value: unknown } | undefined;
      let fatal: UnionConversionError | undefined;
      for (const variant of plan.variants) {
        let candidate: unknown;
        try {
          candidate = convert(value, variant, { ...context, strictObjects, allowCoercion });
        } catch (error) {
          if (!(error instanceof McpToolError)) throw error;
          if (error instanceof UnionConversionError) {
            if (error.reason === "ambiguous" || error.reason === "invalid-value") fatal = error;
            else {
              mismatch = error;
              continue;
            }
          }
          if (strictObjects && matchesContainer(value, variant, context.definitions))
            coveredFailure = error;
          continue;
        }
        if (match && !jsonValuesEqual(match.value, candidate)) {
          fatal = new UnionConversionError(
            "Value matches multiple HTTP union branches with incompatible conversions.",
            "ambiguous",
          );
        }
        match = { value: candidate };
      }
      if (fatal) throw fatal;
      if (match) return match.value;
    }
    if (coveredFailure) throw new UnionConversionError(coveredFailure.message, "invalid-value");
  }
  throw mismatch ?? new McpToolError("Value is outside the declared HTTP union.");
}

function matchesContainer(
  value: unknown,
  plan: HttpWireValuePlan,
  definitions: Definitions,
  seen = new Set<HttpWireValuePlan>(),
): boolean {
  if (seen.has(plan)) return false;
  seen.add(plan);
  switch (plan.kind) {
    case "definition":
      return matchesContainer(
        value,
        plan.value,
        new Map(definitions).set(plan.name, plan.value),
        seen,
      );
    case "ref": {
      const target = definitions.get(plan.name);
      return target !== undefined && matchesContainer(value, target, definitions, seen);
    }
    case "union":
      return plan.variants.some((variant) => matchesContainer(value, variant, definitions, seen));
    case "object":
      return isRecord(value);
    case "array":
    case "tuple":
      return Array.isArray(value);
    default:
      return false;
  }
}

function decodeUncheckedValue(
  value: unknown,
  plan: HttpWireValuePlan,
  context: WireContext,
): unknown {
  const definitions = context.definitions;
  switch (plan.kind) {
    case "identity":
      return value;
    case "definition": {
      const nested = new Map(definitions);
      nested.set(plan.name, plan.value);
      return decodeValue(value, plan.value, { ...context, definitions: nested });
    }
    case "ref": {
      const referenced = definitions.get(plan.name);
      if (!referenced) {
        throw new McpToolError(
          `Unknown HTTP wire transform reference ${JSON.stringify(plan.name)}.`,
        );
      }
      return decodeValue(value, referenced, context);
    }
    case "string":
      if (typeof value === "string") return value;
      throw new McpToolError("Upstream returned a non-string HTTP value.");
    case "number": {
      if (context.allowCoercion === false && typeof value === "string")
        throw new UnionConversionError("HTTP numeric string requires coercion.", "coercion");
      const number =
        typeof value === "number"
          ? value
          : typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)
            ? Number(value)
            : Number.NaN;
      if (!Number.isFinite(number) || (plan.integer && !Number.isSafeInteger(number))) {
        throw new McpToolError(
          `Upstream returned an invalid HTTP ${plan.integer ? "integer" : "number"}.`,
        );
      }
      return number;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      if (context.allowCoercion !== false) {
        if (value === "true") return true;
        if (value === "false") return false;
      } else if (value === "true" || value === "false")
        throw new UnionConversionError("HTTP boolean string requires coercion.", "coercion");
      throw new McpToolError("Upstream returned an invalid HTTP boolean.");
    case "null":
      if (value === null) return null;
      throw new McpToolError("Upstream returned a non-null HTTP value.");
    case "scalar-encoding":
      return decodeHttpScalarEncoding(value, plan.encoding, context.allowCoercion !== false);
    case "literal": {
      const converted = decodeValue(value, literalValuePlan(plan.value), context);
      if (Object.is(converted, plan.value)) return converted;
      throw new UnionConversionError(
        "Upstream returned an unexpected HTTP literal value.",
        "shape",
      );
    }
    case "array": {
      if (!Array.isArray(value) && context.allowCoercion === false)
        throw new UnionConversionError("HTTP scalar requires array coercion.", "coercion");
      const values = Array.isArray(value) ? value : [value];
      return values.map((item) => decodeValue(item, plan.item, context));
    }
    case "tuple":
      if (!Array.isArray(value) || value.length !== plan.items.length) {
        throw new McpToolError(`Upstream returned an HTTP tuple with the wrong length.`);
      }
      return plan.items.map((item, index) => decodeValue(value[index], item, context));
    case "object":
      return convertObject(value, plan, context, decodeValue, false);
    case "union":
      return convertUnion(value, plan, context, decodeValue);
    case "file-json": {
      if (!isRecord(value)) throw new McpToolError("Upstream returned a non-object JSON file.");
      const contents = value[plan.contentsSource];
      if (typeof contents !== "string") {
        throw new McpToolError("Upstream JSON file is missing string contents.");
      }
      const filename = plan.filenameSource ? value[plan.filenameSource] : undefined;
      const mediaType = plan.contentTypeSource ? value[plan.contentTypeSource] : undefined;
      if (filename !== undefined && typeof filename !== "string") {
        throw new McpToolError("Upstream JSON file has an invalid filename.");
      }
      if (mediaType !== undefined && typeof mediaType !== "string") {
        throw new McpToolError("Upstream JSON file has an invalid content type.");
      }
      return {
        name: filename || "file",
        ...(mediaType ? { mediaType } : {}),
        data: plan.textContents ? encodeBase64(new TextEncoder().encode(contents)) : contents,
      };
    }
  }
}

function encodeUncheckedValue(
  value: unknown,
  plan: HttpWireValuePlan,
  context: WireContext,
): unknown {
  const definitions = context.definitions;
  switch (plan.kind) {
    case "identity":
      return value;
    case "definition": {
      const nested = new Map(definitions);
      nested.set(plan.name, plan.value);
      return encodeValue(value, plan.value, { ...context, definitions: nested });
    }
    case "ref": {
      const referenced = definitions.get(plan.name);
      if (!referenced) {
        throw new McpToolError(
          `Unknown HTTP wire transform reference ${JSON.stringify(plan.name)}.`,
        );
      }
      return encodeValue(value, referenced, context);
    }
    case "string":
      if (typeof value === "string") return value;
      throw new McpToolError("Expected a string HTTP request value.");
    case "number":
      if (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (!plan.integer || Number.isSafeInteger(value))
      ) {
        return value;
      }
      throw new McpToolError(`Expected an HTTP request ${plan.integer ? "integer" : "number"}.`);
    case "boolean":
      if (typeof value === "boolean") return value;
      throw new McpToolError("Expected a boolean HTTP request value.");
    case "null":
      if (value === null) return null;
      throw new McpToolError("Expected a null HTTP request value.");
    case "scalar-encoding":
      return encodeHttpScalarEncoding(value, plan.encoding);
    case "literal":
      if (Object.is(value, plan.value)) return value;
      throw new UnionConversionError("Expected the declared HTTP request literal.", "shape");
    case "array":
      if (!Array.isArray(value)) throw new McpToolError("Expected an HTTP request array.");
      return value.map((item) => encodeValue(item, plan.item, context));
    case "tuple":
      if (!Array.isArray(value) || value.length !== plan.items.length) {
        throw new McpToolError("Expected an HTTP request tuple with the declared length.");
      }
      return plan.items.map((item, index) => encodeValue(value[index], item, context));
    case "object":
      return convertObject(value, plan, context, encodeValue, true);
    case "union":
      return convertUnion(value, plan, context, encodeValue);
    case "file-json": {
      const file = asFileRecord(value);
      const output: Record<string, unknown> = Object.create(null);
      if (plan.contentTypeSource && file.mediaType) {
        output[plan.contentTypeSource] = file.mediaType;
      }
      if (plan.filenameSource) output[plan.filenameSource] = file.name;
      output[plan.contentsSource] = plan.textContents
        ? new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64(file.data))
        : file.data;
      return output;
    }
  }
}

function convertObject(
  value: unknown,
  plan: Extract<HttpWireValuePlan, { kind: "object" }>,
  context: WireContext,
  convert: Convert,
  encoding: boolean,
): unknown {
  if (!isRecord(value))
    throw new McpToolError(
      encoding ? "Expected an HTTP request object." : "Upstream returned a non-object HTTP value.",
    );
  const properties = Object.entries(plan.properties);
  const known = new Set(
    properties.map(([target, property]) => (encoding ? target : property.sourceName)),
  );
  const outputNames = new Set(
    properties.map(([target, property]) => (encoding ? property.sourceName : target)),
  );
  if (
    context.strictObjects &&
    !plan.additional &&
    Object.keys(value).some((name) => !known.has(name))
  ) {
    throw new UnionConversionError(
      "Property is not declared by this HTTP union branch.",
      "projection",
    );
  }
  const output: Record<string, unknown> = Object.create(null);
  const errors: McpToolError[] = [];
  for (const [target, property] of properties) {
    const inputName = encoding ? target : property.sourceName;
    if (!Object.hasOwn(value, inputName)) {
      if (!property.optional)
        errors.push(
          new UnionConversionError(`HTTP object is missing ${JSON.stringify(inputName)}.`, "shape"),
        );
      continue;
    }
    const item = value[inputName];
    try {
      output[encoding ? property.sourceName : target] = convert(item, property.value, context);
    } catch (error) {
      if (!(error instanceof McpToolError)) throw error;
      errors.push(
        error instanceof UnionConversionError &&
          error.reason === "shape" &&
          matchesContainer(item, property.value, context.definitions)
          ? new McpToolError(error.message)
          : error,
      );
    }
  }
  if (plan.additional) {
    for (const name of Object.keys(value)) {
      if (known.has(name)) continue;
      if (outputNames.has(name))
        throw new McpToolError("Additional HTTP property collides with a declared property.");
      try {
        output[name] = convert(value[name], plan.additional, context);
      } catch (error) {
        if (!(error instanceof McpToolError)) throw error;
        errors.push(error);
      }
    }
  }
  // A mismatched discriminator or missing field makes the whole branch ineligible,
  // even when a different property contains an otherwise ambiguous union.
  if (errors.length)
    throw (
      errors.find((error) => error instanceof UnionConversionError && error.reason === "shape") ??
      errors.find(
        (error) => error instanceof UnionConversionError && error.reason === "projection",
      ) ??
      errors.find(
        (error) => !(error instanceof UnionConversionError) || error.reason === "coercion",
      ) ??
      errors[0]
    );
  return output;
}

function literalValuePlan(value: string | number | boolean | null): HttpWireValuePlan {
  return value === null
    ? { kind: "null" }
    : typeof value === "string"
      ? { kind: "string" }
      : typeof value === "number"
        ? { kind: "number", integer: Number.isInteger(value) }
        : { kind: "boolean" };
}

function decodeHttpScalarEncoding(
  value: unknown,
  encoding: Extract<HttpWireValuePlan, { kind: "scalar-encoding" }>["encoding"],
  allowCoercion: boolean,
): unknown {
  if (
    !allowCoercion &&
    typeof value === "string" &&
    (encoding === "unix-timestamp" ||
      encoding === "duration-seconds" ||
      encoding === "duration-milliseconds")
  )
    throw new UnionConversionError("HTTP numeric string requires coercion.", "coercion");
  try {
    switch (encoding) {
      case "number-string":
        return ScalarEncodings.decodeNumberString(requireString(value));
      case "integer-string":
        return ScalarEncodings.decodeIntegerString(requireString(value));
      case "boolean-string":
        return ScalarEncodings.decodeBooleanString(requireString(value));
      case "rfc7231":
        return ScalarEncodings.decodeRfc7231DateTime(requireString(value));
      case "unix-timestamp":
        return ScalarEncodings.decodeUnixTimestamp(requireHttpNumber(value, true));
      case "duration-seconds":
        return ScalarEncodings.decodeNumericDuration(requireHttpNumber(value, false), "seconds");
      case "duration-milliseconds":
        return ScalarEncodings.decodeNumericDuration(
          requireHttpNumber(value, false),
          "milliseconds",
        );
      case "base64url":
        return encodeBase64(ScalarEncodings.decodeBase64Url(requireString(value)));
    }
  } catch (error) {
    throw new McpToolError(`Upstream returned an invalid ${encoding} HTTP value.`, {
      cause: error,
    });
  }
}

function encodeHttpScalarEncoding(
  value: unknown,
  encoding: Extract<HttpWireValuePlan, { kind: "scalar-encoding" }>["encoding"],
): unknown {
  try {
    switch (encoding) {
      case "number-string":
        return ScalarEncodings.encodeNumberString(requireNumber(value));
      case "integer-string":
        return ScalarEncodings.encodeNumberString(requireNumber(value), { integer: true });
      case "boolean-string":
        if (typeof value !== "boolean") throw new TypeError("Expected a boolean.");
        return ScalarEncodings.encodeBooleanString(value);
      case "rfc7231":
        return ScalarEncodings.encodeRfc7231DateTime(requireString(value));
      case "unix-timestamp":
        return ScalarEncodings.encodeUnixTimestamp(requireString(value));
      case "duration-seconds":
        return ScalarEncodings.encodeNumericDuration(requireString(value), "seconds");
      case "duration-milliseconds":
        return ScalarEncodings.encodeNumericDuration(requireString(value), "milliseconds");
      case "base64url":
        return ScalarEncodings.encodeBase64Url(decodeBase64(requireString(value)));
    }
  } catch (error) {
    throw new McpToolError(`Expected a valid ${encoding} HTTP request value.`, { cause: error });
  }
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Expected a string.");
  return value;
}

function requireNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Expected a finite number.");
  }
  return value;
}

function requireHttpNumber(value: unknown, integer: boolean): number {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(number) || (integer && !Number.isSafeInteger(number))) {
    throw new TypeError(`Expected a finite ${integer ? "integer" : "number"}.`);
  }
  return number;
}
