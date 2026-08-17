import { ScalarEncodings } from "@typespex/codec";
import type { HttpWireValuePlan } from "@typespex/http-client";
import { McpToolError } from "@typespex/mcp-server";
import { asFileRecord, decodeBase64, encodeBase64 } from "./binary.js";
import { isRecord } from "./value-paths.js";

export function decodeHttpWireValue(
  value: unknown,
  plan: HttpWireValuePlan,
  definitions: ReadonlyMap<string, HttpWireValuePlan> = new Map(),
): unknown {
  switch (plan.kind) {
    case "identity":
      return value;
    case "definition": {
      const nested = new Map(definitions);
      nested.set(plan.name, plan.value);
      return decodeHttpWireValue(value, plan.value, nested);
    }
    case "ref": {
      const referenced = definitions.get(plan.name);
      if (!referenced) {
        throw new McpToolError(
          `Unknown HTTP wire transform reference ${JSON.stringify(plan.name)}.`,
        );
      }
      return decodeHttpWireValue(value, referenced, definitions);
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
      const converted = decodeHttpWireValue(value, literalValuePlan(plan.value), definitions);
      if (Object.is(converted, plan.value)) return converted;
      throw new McpToolError("Upstream returned an unexpected HTTP literal value.");
    }
    case "array": {
      const values = Array.isArray(value) ? value : [value];
      return values.map((item) => decodeHttpWireValue(item, plan.item, definitions));
    }
    case "tuple":
      if (!Array.isArray(value) || value.length !== plan.items.length) {
        throw new McpToolError(`Upstream returned an HTTP tuple with the wrong length.`);
      }
      return plan.items.map((item, index) => decodeHttpWireValue(value[index], item, definitions));
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
        output[targetName] = decodeHttpWireValue(
          value[property.sourceName],
          property.value,
          definitions,
        );
      }
      if (plan.additional) {
        for (const [name, item] of Object.entries(value)) {
          if (!known.has(name)) {
            output[name] = decodeHttpWireValue(item, plan.additional, definitions);
          }
        }
      }
      return output;
    }
    case "union": {
      for (const variant of plan.variants) {
        try {
          return decodeHttpWireValue(value, variant, definitions);
        } catch (error) {
          if (!(error instanceof McpToolError)) throw error;
        }
      }
      throw new McpToolError("Upstream returned a value outside the declared HTTP union.");
    }
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

export function encodeHttpWireValue(
  value: unknown,
  plan: HttpWireValuePlan,
  definitions: ReadonlyMap<string, HttpWireValuePlan> = new Map(),
): unknown {
  switch (plan.kind) {
    case "identity":
      return value;
    case "definition": {
      const nested = new Map(definitions);
      nested.set(plan.name, plan.value);
      return encodeHttpWireValue(value, plan.value, nested);
    }
    case "ref": {
      const referenced = definitions.get(plan.name);
      if (!referenced) {
        throw new McpToolError(
          `Unknown HTTP wire transform reference ${JSON.stringify(plan.name)}.`,
        );
      }
      return encodeHttpWireValue(value, referenced, definitions);
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
      return value.map((item) => encodeHttpWireValue(item, plan.item, definitions));
    case "tuple":
      if (!Array.isArray(value) || value.length !== plan.items.length) {
        throw new McpToolError("Expected an HTTP request tuple with the declared length.");
      }
      return plan.items.map((item, index) => encodeHttpWireValue(value[index], item, definitions));
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
        output[property.sourceName] = encodeHttpWireValue(
          value[targetName],
          property.value,
          definitions,
        );
      }
      if (plan.additional) {
        for (const [name, item] of Object.entries(value)) {
          if (!known.has(name)) {
            output[name] = encodeHttpWireValue(item, plan.additional, definitions);
          }
        }
      }
      return output;
    }
    case "union":
      for (const variant of plan.variants) {
        try {
          return encodeHttpWireValue(value, variant, definitions);
        } catch (error) {
          if (!(error instanceof McpToolError)) throw error;
        }
      }
      throw new McpToolError("HTTP request value is outside the declared union.");
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
