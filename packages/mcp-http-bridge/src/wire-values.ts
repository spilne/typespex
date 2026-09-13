import { ScalarEncodings, jsonValuesEqual } from "@typespex/codec";
import type { HttpWireValuePlan } from "@typespex/http-client";
import { McpToolError } from "@typespex/mcp-server";
import { asFileRecord, decodeBase64, encodeBase64 } from "./binary.js";
import { isRecord } from "./value-paths.js";

type Definitions = ReadonlyMap<string, HttpWireValuePlan>;
type WireCache = WeakMap<object, Map<HttpWireValuePlan, unknown>>;
interface WireContext {
  readonly definitions: Definitions;
  readonly strictObjects?: boolean;
  readonly depth: number;
  readonly completed: Map<Definitions, readonly [WireCache, WireCache]>;
  readonly active: Map<
    Definitions,
    readonly [WeakMap<object, Set<HttpWireValuePlan>>, WeakMap<object, Set<HttpWireValuePlan>>]
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
    context.completed.set(context.definitions, (caches = [new WeakMap(), new WeakMap()]));
  let active = context.active.get(context.definitions);
  if (!active) context.active.set(context.definitions, (active = [new WeakMap(), new WeakMap()]));
  const mode = context.strictObjects ? 1 : 0;
  const previous = caches[mode].get(value);
  if (previous?.has(plan)) return previous.get(plan);
  const pending = active[mode].get(value) ?? new Set<HttpWireValuePlan>();
  if (pending.has(plan)) throw new McpToolError("Cyclic values cannot be converted as HTTP JSON.");
  pending.add(plan);
  active[mode].set(value, pending);
  try {
    const result = convert(value, plan, next);
    const completed = caches[mode].get(value) ?? new Map<HttpWireValuePlan, unknown>();
    completed.set(plan, result);
    caches[mode].set(value, completed);
    return result;
  } finally {
    pending.delete(plan);
  }
}

function convertUnion(
  value: unknown,
  plan: Extract<HttpWireValuePlan, { kind: "union" }>,
  context: WireContext,
  convert: Convert,
): unknown {
  for (const strictObjects of context.strictObjects ? [true] : [true, false]) {
    let match: { value: unknown } | undefined;
    for (const variant of plan.variants) {
      let candidate: unknown;
      try {
        candidate = convert(value, variant, { ...context, strictObjects });
      } catch (error) {
        if (!(error instanceof McpToolError)) throw error;
        continue;
      }
      if (match && !jsonValuesEqual(match.value, candidate)) {
        throw new McpToolError(
          "Value matches multiple HTTP union branches with incompatible conversions.",
        );
      }
      match = { value: candidate };
    }
    if (match) return match.value;
  }
  throw new McpToolError("Value is outside the declared HTTP union.");
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
      if (value === "true") return true;
      if (value === "false") return false;
      throw new McpToolError("Upstream returned an invalid HTTP boolean.");
    case "null":
      if (value === null) return null;
      throw new McpToolError("Upstream returned a non-null HTTP value.");
    case "scalar-encoding":
      return decodeHttpScalarEncoding(value, plan.encoding);
    case "literal": {
      const converted = decodeValue(value, literalValuePlan(plan.value), context);
      if (Object.is(converted, plan.value)) return converted;
      throw new McpToolError("Upstream returned an unexpected HTTP literal value.");
    }
    case "array": {
      const values = Array.isArray(value) ? value : [value];
      return values.map((item) => decodeValue(item, plan.item, context));
    }
    case "tuple":
      if (!Array.isArray(value) || value.length !== plan.items.length) {
        throw new McpToolError(`Upstream returned an HTTP tuple with the wrong length.`);
      }
      return plan.items.map((item, index) => decodeValue(value[index], item, context));
    case "object": {
      if (!isRecord(value)) throw new McpToolError("Upstream returned a non-object HTTP value.");
      const output: Record<string, unknown> = Object.create(null);
      const known = new Set<string>();
      for (const [targetName, property] of Object.entries(plan.properties)) {
        known.add(property.sourceName);
        if (!Object.hasOwn(value, property.sourceName)) {
          if (!property.optional) {
            throw new McpToolError(
              `Upstream HTTP object is missing ${JSON.stringify(property.sourceName)}.`,
            );
          }
          continue;
        }
        output[targetName] = decodeValue(value[property.sourceName], property.value, context);
      }
      if (
        context.strictObjects &&
        !plan.additional &&
        Object.keys(value).some((name) => !known.has(name))
      ) {
        throw new McpToolError("Property is not declared by this HTTP union branch.");
      }
      if (plan.additional) {
        for (const [name, item] of Object.entries(value)) {
          if (!known.has(name)) {
            if (Object.hasOwn(output, name))
              throw new McpToolError("Additional HTTP property collides with a declared property.");
            output[name] = decodeValue(item, plan.additional, context);
          }
        }
      }
      return output;
    }
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
      throw new McpToolError("Expected the declared HTTP request literal.");
    case "array":
      if (!Array.isArray(value)) throw new McpToolError("Expected an HTTP request array.");
      return value.map((item) => encodeValue(item, plan.item, context));
    case "tuple":
      if (!Array.isArray(value) || value.length !== plan.items.length) {
        throw new McpToolError("Expected an HTTP request tuple with the declared length.");
      }
      return plan.items.map((item, index) => encodeValue(value[index], item, context));
    case "object": {
      if (!isRecord(value)) throw new McpToolError("Expected an HTTP request object.");
      const output: Record<string, unknown> = Object.create(null);
      const known = new Set<string>();
      for (const [targetName, property] of Object.entries(plan.properties)) {
        known.add(targetName);
        if (!Object.hasOwn(value, targetName)) {
          if (!property.optional) {
            throw new McpToolError(`HTTP request object is missing ${JSON.stringify(targetName)}.`);
          }
          continue;
        }
        output[property.sourceName] = encodeValue(value[targetName], property.value, context);
      }
      if (
        context.strictObjects &&
        !plan.additional &&
        Object.keys(value).some((name) => !known.has(name))
      ) {
        throw new McpToolError("Property is not declared by this HTTP union branch.");
      }
      if (plan.additional) {
        for (const [name, item] of Object.entries(value)) {
          if (!known.has(name)) {
            if (Object.hasOwn(output, name))
              throw new McpToolError("Additional HTTP property collides with a declared property.");
            output[name] = encodeValue(item, plan.additional, context);
          }
        }
      }
      return output;
    }
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
): unknown {
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
