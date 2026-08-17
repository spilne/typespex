import { readBoundedBody, readBoundedJsonLines } from "@typespex/http-client";
import { McpToolError } from "@typespex/mcp-server";
import type {
  HttpBridgeResponse,
  HttpBridgeResponseMultipartPart,
  McpHttpBridgeOptions,
} from "./contracts.js";
import { asBodyBytes, encodeBase64, fileToRecord, responseFileName } from "./binary.js";
import { boundedInteger, upstreamRequestFailure } from "./errors.js";
import { setSafeHeader } from "./http-headers.js";
import { splitHttpList } from "./http-serialization.js";
import { extractMediaType, mediaTypeMatches, normalizeMediaType } from "./media-types.js";
import { isRecord, setTargetValue } from "./value-paths.js";
import { decodeHttpWireValue } from "./wire-values.js";

const DEFAULT_MAX_JSONL_ITEMS = 1_000;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_DIAGNOSTIC_BYTES = 64 * 1024;

export async function decodeHttpBridgeResponse(
  response: Response,
  descriptor: HttpBridgeResponse,
  options: McpHttpBridgeOptions,
  signal: AbortSignal,
): Promise<unknown> {
  const kind = descriptor.kind ?? inferResponseKind(response.headers.get("content-type"));
  const maxBytes = boundedInteger(
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    "maxResponseBytes",
    1,
  );
  let body: unknown;
  switch (kind) {
    case "empty":
      await cancelUpstreamResponse(response);
      body = undefined;
      break;
    case "jsonl":
      body = await readJsonl(
        response,
        boundedInteger(options.maxJsonlItems ?? DEFAULT_MAX_JSONL_ITEMS, "maxJsonlItems", 1),
        maxBytes,
        signal,
      );
      break;
    case "json": {
      const bytes = await readLimitedBytes(response, maxBytes, signal);
      if (bytes.length === 0) body = undefined;
      else {
        try {
          body = JSON.parse(new TextDecoder().decode(bytes));
        } catch (error) {
          throw new McpToolError("Upstream returned invalid JSON.", { cause: error });
        }
      }
      break;
    }
    case "form": {
      const text = new TextDecoder().decode(await readLimitedBytes(response, maxBytes, signal));
      const values = new URLSearchParams(text);
      const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [name, value] of values) {
        const existing = output[name];
        output[name] =
          existing === undefined
            ? value
            : Array.isArray(existing)
              ? [...existing, value]
              : [existing, value];
      }
      body = output;
      break;
    }
    case "multipart": {
      const bytes = await readLimitedBytes(response, maxBytes, signal);
      const contentType = response.headers.get("content-type") ?? "multipart/form-data";
      if (descriptor.multipartParts) {
        body = decodePlannedMultipartBody(bytes, contentType, descriptor.multipartParts);
      } else {
        const parsed = await new Response(asBodyBytes(bytes), {
          headers: { "Content-Type": contentType },
        }).formData();
        const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        for (const [name, value] of parsed) {
          const wireValue = typeof value === "string" ? value : await fileToRecord(value);
          const existing = output[name];
          output[name] =
            existing === undefined
              ? wireValue
              : Array.isArray(existing)
                ? [...existing, wireValue]
                : [existing, wireValue];
        }
        body = output;
      }
      break;
    }
    case "text":
      body = new TextDecoder().decode(await readLimitedBytes(response, maxBytes, signal));
      break;
    case "binary":
      body = encodeBase64(await readLimitedBytes(response, maxBytes, signal));
      break;
    case "file": {
      const bytes = await readLimitedBytes(response, maxBytes, signal);
      const mediaType = extractMediaType(response.headers.get("content-type"));
      body = {
        name: responseFileName(response.headers.get("content-disposition")) ?? "response.bin",
        ...(mediaType ? { mediaType } : {}),
        data: encodeBase64(bytes),
      };
      break;
    }
  }
  if (descriptor.bodyValue) body = decodeHttpWireValue(body, descriptor.bodyValue);

  if (
    !descriptor.bodyTarget &&
    !descriptor.statusTarget &&
    !descriptor.contentTypeTarget &&
    !descriptor.headers?.length
  ) {
    return body;
  }
  let output: unknown =
    !descriptor.bodyTarget && isRecord(body) ? { ...body } : Object.create(null);
  if (descriptor.bodyTarget) output = setTargetValue(output, descriptor.bodyTarget, body);
  if (descriptor.statusTarget) {
    output = setTargetValue(output, descriptor.statusTarget, response.status);
  }
  if (descriptor.contentTypeTarget) {
    output = setTargetValue(
      output,
      descriptor.contentTypeTarget,
      extractMediaType(response.headers.get("content-type")),
    );
  }
  for (const header of descriptor.headers ?? []) {
    const value = response.headers.get(header.name);
    if (value !== null) {
      const wireValue = header.collection ? splitHttpList(value) : value;
      output = setTargetValue(
        output,
        header.target,
        header.value ? decodeHttpWireValue(wireValue, header.value) : wireValue,
      );
    }
  }
  return output;
}

async function readJsonl(
  response: Response,
  maxItems: number,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown[]> {
  try {
    return await readBoundedJsonLines(
      response,
      { maximumItems: maxItems, maximumBytes: maxBytes },
      signal,
    );
  } catch (error) {
    throw upstreamRequestFailure(error);
  }
}

interface ParsedMimePart {
  readonly headers: Headers;
  readonly body: Uint8Array;
  readonly name?: string;
  readonly fileName?: string;
}

function decodePlannedMultipartBody(
  bytes: Uint8Array,
  contentType: string,
  descriptors: readonly HttpBridgeResponseMultipartPart[],
): unknown {
  const parsed = parseMultipartBytes(bytes, contentType);
  const values = new Map<HttpBridgeResponseMultipartPart, unknown[]>();
  const unnamed = descriptors.filter((descriptor) => !descriptor.name);
  let unnamedIndex = 0;
  for (let index = 0; index < parsed.length; index += 1) {
    const part = parsed[index]!;
    let descriptor = part.name
      ? descriptors.find((candidate) => candidate.name === part.name)
      : undefined;
    if (!descriptor) {
      while (unnamedIndex < unnamed.length) {
        const candidate = unnamed[unnamedIndex]!;
        if (!candidate.multi) {
          descriptor = candidate;
          unnamedIndex += 1;
          break;
        }
        const remainingParts = parsed.length - index;
        const requiredAfter = unnamed
          .slice(unnamedIndex + 1)
          .filter((item) => !item.optional && !item.multi).length;
        if (remainingParts <= requiredAfter) {
          unnamedIndex += 1;
          continue;
        }
        descriptor = candidate;
        break;
      }
    }
    if (!descriptor) throw new McpToolError("Upstream returned an undeclared multipart part.");
    const actualContentType = extractMediaType(part.headers.get("content-type"));
    if (
      descriptor.contentTypes.length > 0 &&
      (!actualContentType ||
        !descriptor.contentTypes.some((declared) => mediaTypeMatches(actualContentType, declared)))
    ) {
      throw new McpToolError(
        `Upstream multipart part ${JSON.stringify(descriptor.name ?? descriptor.target.join("."))} has an undeclared Content-Type.`,
      );
    }
    const decoded = decodeMultipartPart(part, descriptor);
    const existing = values.get(descriptor) ?? [];
    existing.push(decoded);
    values.set(descriptor, existing);
  }

  let output: unknown = typeof descriptors[0]?.target[0] === "number" ? [] : Object.create(null);
  for (const descriptor of descriptors) {
    const matches = values.get(descriptor) ?? [];
    if (!descriptor.multi && matches.length > 1) {
      throw new McpToolError(
        `Upstream returned multipart part ${JSON.stringify(descriptor.name)} more than once.`,
      );
    }
    if (matches.length === 0) {
      if (descriptor.multi && !descriptor.optional) {
        output = setTargetValue(output, descriptor.target, []);
      } else if (!descriptor.optional) {
        throw new McpToolError(
          `Upstream omitted required multipart part ${JSON.stringify(descriptor.name ?? descriptor.target.join("."))}.`,
        );
      }
      continue;
    }
    output = setTargetValue(output, descriptor.target, descriptor.multi ? matches : matches[0]);
  }
  return output;
}

function decodeMultipartPart(
  part: ParsedMimePart,
  descriptor: HttpBridgeResponseMultipartPart,
): unknown {
  const contentType = extractMediaType(part.headers.get("content-type"));
  let value: unknown;
  switch (descriptor.kind) {
    case "file":
      value = {
        name: part.fileName ?? "file",
        ...(contentType ? { mediaType: contentType } : {}),
        data: encodeBase64(part.body),
      };
      break;
    case "binary":
      value = encodeBase64(part.body);
      break;
    case "text":
      value = new TextDecoder().decode(part.body);
      break;
    case "json":
      try {
        value = JSON.parse(new TextDecoder().decode(part.body));
      } catch (error) {
        throw new McpToolError("Upstream returned invalid JSON in a multipart part.", {
          cause: error,
        });
      }
      break;
  }
  return descriptor.value ? decodeHttpWireValue(value, descriptor.value) : value;
}

function parseMultipartBytes(bytes: Uint8Array, contentType: string): ParsedMimePart[] {
  const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) {
    throw new McpToolError("Upstream multipart response has an invalid boundary.");
  }
  const delimiter = new TextEncoder().encode(`--${boundary}`);
  const headerSeparator = new Uint8Array([13, 10, 13, 10]);
  const nextPrefix = new TextEncoder().encode(`\r\n--${boundary}`);
  const delimiterMatcher = createByteMatcher(delimiter);
  const headerSeparatorMatcher = createByteMatcher(headerSeparator);
  const nextPrefixMatcher = createByteMatcher(nextPrefix);
  const output: ParsedMimePart[] = [];
  let cursor = delimiterMatcher.find(bytes, 0);
  if (cursor < 0) throw new McpToolError("Upstream multipart boundary was not found.");
  while (cursor >= 0) {
    cursor += delimiter.length;
    if (bytes[cursor] === 45 && bytes[cursor + 1] === 45) break;
    if (bytes[cursor] !== 13 || bytes[cursor + 1] !== 10) {
      throw new McpToolError("Upstream multipart framing is invalid.");
    }
    cursor += 2;
    const headersEnd = headerSeparatorMatcher.find(bytes, cursor);
    if (headersEnd < 0) throw new McpToolError("Upstream multipart headers are incomplete.");
    const headers = parseMimeHeaders(bytes.subarray(cursor, headersEnd));
    const bodyStart = headersEnd + headerSeparator.length;
    const next = nextPrefixMatcher.find(bytes, bodyStart);
    if (next < 0) throw new McpToolError("Upstream multipart closing boundary is missing.");
    const disposition = headers.get("content-disposition");
    output.push({
      headers,
      body: bytes.slice(bodyStart, next),
      ...(mimeDispositionParameter(disposition, "name")
        ? { name: mimeDispositionParameter(disposition, "name") }
        : {}),
      ...(responseFileName(disposition) ? { fileName: responseFileName(disposition) } : {}),
    });
    cursor = next + 2;
  }
  return output;
}

function parseMimeHeaders(bytes: Uint8Array): Headers {
  const headers = new Headers();
  for (const line of new TextDecoder().decode(bytes).split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new McpToolError("Upstream multipart header is malformed.");
    setSafeHeader(headers, line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return headers;
}

function mimeDispositionParameter(
  disposition: string | null,
  parameter: string,
): string | undefined {
  if (!disposition) return undefined;
  const match = new RegExp(`(?:^|;)\\s*${parameter}=(?:"((?:\\\\.|[^"])*)"|([^;\\s]+))`, "i").exec(
    disposition,
  );
  const value = match?.[1]?.replaceAll(/\\(.)/g, "$1") ?? match?.[2];
  return value || undefined;
}

function createByteMatcher(needle: Uint8Array): {
  find(haystack: Uint8Array, start: number): number;
} {
  const fallback = new Uint32Array(needle.length);
  for (let index = 1, matched = 0; index < needle.length; index += 1) {
    while (matched > 0 && needle[index] !== needle[matched]) matched = fallback[matched - 1]!;
    if (needle[index] === needle[matched]) matched += 1;
    fallback[index] = matched;
  }
  return {
    find(haystack, start) {
      if (needle.length === 0) return Math.min(Math.max(start, 0), haystack.length);
      let matched = 0;
      for (let index = Math.max(start, 0); index < haystack.length; index += 1) {
        while (matched > 0 && haystack[index] !== needle[matched]) {
          matched = fallback[matched - 1]!;
        }
        if (haystack[index] === needle[matched]) matched += 1;
        if (matched === needle.length) return index - needle.length + 1;
      }
      return -1;
    },
  };
}

async function readLimitedBytes(
  response: Response,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  try {
    return await readBoundedBody(response, maximum, signal);
  } catch (error) {
    throw upstreamRequestFailure(error);
  }
}

export function selectHttpBridgeResponse(
  responses: readonly HttpBridgeResponse[],
  status: number,
  contentType: string | null,
): HttpBridgeResponse | undefined {
  const mediaType = normalizeMediaType(contentType);
  return responses
    .flatMap((response) => {
      const statusScore = Math.max(
        ...response.statuses.map((declared) =>
          declared === "default"
            ? 1
            : typeof declared === "number"
              ? declared === status
                ? 3
                : -1
              : Number(declared[0]) === Math.floor(status / 100)
                ? 2
                : -1,
        ),
      );
      if (statusScore < 0) return [];
      const mediaScore = !response.mediaTypes?.length
        ? mediaType === undefined || response.kind === "empty"
          ? 2
          : 0
        : Math.max(
            ...response.mediaTypes.map((declared) =>
              mediaTypeMatches(mediaType, declared)
                ? normalizeMediaType(declared) === mediaType
                  ? 2
                  : 1
                : -1,
            ),
          );
      return mediaScore < 0 ? [] : [{ response, score: statusScore * 10 + mediaScore }];
    })
    .sort((left, right) => right.score - left.score)[0]?.response;
}

export async function readUpstreamDiagnostic(
  response: Response,
  maximum = DEFAULT_MAX_DIAGNOSTIC_BYTES,
  signal: AbortSignal,
): Promise<string> {
  const cap = boundedInteger(maximum, "maxDiagnosticBytes", 1);
  if (!response.body) return "";
  let bytes: Uint8Array;
  try {
    bytes = await readLimitedBytes(response, cap, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    bytes = new Uint8Array();
  }
  return new TextDecoder().decode(bytes).replaceAll(/\s+/g, " ").trim();
}

export async function cancelUpstreamResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup must not replace the declared MCP result or operational error.
  }
}

function inferResponseKind(contentType: string | null): NonNullable<HttpBridgeResponse["kind"]> {
  const mediaType = normalizeMediaType(contentType) ?? "";
  if (mediaType === "application/jsonl" || mediaType === "application/x-ndjson") return "jsonl";
  if (mediaType === "application/json" || mediaType.endsWith("+json")) return "json";
  if (mediaType === "application/x-www-form-urlencoded") return "form";
  if (mediaType.startsWith("multipart/")) return "multipart";
  if (mediaType.startsWith("text/")) return "text";
  return "binary";
}
