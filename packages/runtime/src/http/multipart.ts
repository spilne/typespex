import { parseMediaType } from "./media-type.js";

const MAX_BOUNDARY_LENGTH = 70;
const MAX_PARTS = 256;
const MAX_HEADERS_PER_PART = 64;
const MAX_HEADER_BYTES_PER_PART = 16 * 1024;
const MAX_HEADER_LINE_BYTES = 8 * 1024;
const MAX_PARAMETER_LENGTH = 1024;

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const BOUNDARY = /^[0-9A-Za-z'()+_,\-./:=? ]+$/;
const textEncoder = new TextEncoder();
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export interface ParsedMultipartDisposition {
  readonly type: string;
  readonly name?: string;
  readonly filename?: string;
}

export interface ParsedMultipartPart {
  readonly headers: ReadonlyMap<string, string>;
  readonly body: Uint8Array;
  readonly contentType?: string;
  readonly disposition?: ParsedMultipartDisposition;
}

export interface ParsedMultipartBody {
  readonly mediaType: string;
  readonly boundary: string;
  readonly parts: readonly ParsedMultipartPart[];
}

/** Internal syntax failure converted to a structured body validation issue. */
export class MultipartSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MultipartSyntaxError";
  }
}

/**
 * Parses a MIME multipart request without routing part bytes through strings or
 * `FormData`. The parser intentionally applies conservative structural limits;
 * the whole-request byte limit is owned by the server body-limit layer.
 */
export async function parseMultipartRequest(request: Request): Promise<ParsedMultipartBody> {
  const contentType = request.headers.get("content-type");
  const parsedContentType = parseParameterizedValue(contentType, "Content-Type");
  const mediaType = parseMediaType(parsedContentType.value);
  if (!mediaType || !mediaType.startsWith("multipart/")) {
    throw new MultipartSyntaxError("Expected a multipart Content-Type.");
  }

  const boundary = parsedContentType.parameters.get("boundary");
  if (boundary === undefined) {
    throw new MultipartSyntaxError("Multipart Content-Type is missing its boundary parameter.");
  }
  validateBoundary(boundary);

  const bytes = new Uint8Array(await request.arrayBuffer());
  return {
    mediaType,
    boundary,
    parts: parseMultipartBytes(bytes, boundary),
  };
}

function validateBoundary(boundary: string): void {
  if (
    boundary.length === 0 ||
    boundary.length > MAX_BOUNDARY_LENGTH ||
    !BOUNDARY.test(boundary) ||
    boundary.endsWith(" ")
  ) {
    throw new MultipartSyntaxError("Multipart boundary is invalid.");
  }
}

function parseMultipartBytes(bytes: Uint8Array, boundary: string): ParsedMultipartPart[] {
  const delimiter = concatBytes(textEncoder.encode("--"), textEncoder.encode(boundary));
  const innerDelimiter = concatBytes(CRLF, delimiter);
  const initialBoundary = findInitialBoundary(bytes, delimiter, innerDelimiter);
  if (!initialBoundary) {
    throw new MultipartSyntaxError("Multipart body does not contain its declared boundary.");
  }
  if (initialBoundary.closing) return [];

  let position = initialBoundary.next;

  const parts: ParsedMultipartPart[] = [];
  for (;;) {
    if (parts.length >= MAX_PARTS) {
      throw new MultipartSyntaxError(`Multipart body exceeds the ${MAX_PARTS}-part limit.`);
    }

    const hasNoHeaders = startsWithBytes(bytes, CRLF, position);
    const headerEnd = hasNoHeaders ? position : findBytes(bytes, DOUBLE_CRLF, position);
    if (headerEnd === -1 || headerEnd - position > MAX_HEADER_BYTES_PER_PART) {
      throw new MultipartSyntaxError("Multipart part headers are missing or too large.");
    }
    const headers = parsePartHeaders(bytes.subarray(position, headerEnd));
    const bodyStart = headerEnd + (hasNoHeaders ? CRLF.length : DOUBLE_CRLF.length);
    const boundaryStart = findMultipartDelimiter(bytes, innerDelimiter, bodyStart);
    if (boundaryStart === -1) {
      throw new MultipartSyntaxError("Multipart body is missing its closing boundary.");
    }

    const body = bytes.slice(bodyStart, boundaryStart);
    parts.push(buildParsedPart(headers, body));

    position = boundaryStart + innerDelimiter.length;
    const boundaryLine = parseBoundaryLine(bytes, position);
    if (!boundaryLine) {
      throw new MultipartSyntaxError("Multipart part boundary is malformed.");
    }
    if (boundaryLine.closing) return parts;
    position = boundaryLine.next;
  }
}

interface ParsedBoundaryLine {
  readonly closing: boolean;
  /** First byte after the delimiter line; epilogue start for a closing delimiter. */
  readonly next: number;
}

function findInitialBoundary(
  bytes: Uint8Array,
  delimiter: Uint8Array,
  innerDelimiter: Uint8Array,
): ParsedBoundaryLine | undefined {
  if (startsWithBytes(bytes, delimiter, 0)) {
    const atStart = parseBoundaryLine(bytes, delimiter.length);
    if (atStart) return atStart;
  }

  let candidate = 0;
  for (;;) {
    candidate = findBytes(bytes, innerDelimiter, candidate);
    if (candidate === -1) return undefined;
    const line = parseBoundaryLine(bytes, candidate + innerDelimiter.length);
    if (line) return line;
    candidate += 1;
  }
}

function findMultipartDelimiter(bytes: Uint8Array, delimiter: Uint8Array, from: number): number {
  let candidate = from;
  for (;;) {
    candidate = findBytes(bytes, delimiter, candidate);
    if (candidate === -1) return -1;
    if (parseBoundaryLine(bytes, candidate + delimiter.length)) {
      return candidate;
    }
    candidate += 1;
  }
}

function parseBoundaryLine(
  bytes: Uint8Array,
  afterDelimiter: number,
): ParsedBoundaryLine | undefined {
  let position = afterDelimiter;
  const closing = startsWithBytes(bytes, DOUBLE_DASH, position);
  if (closing) position += DOUBLE_DASH.length;
  while (position < bytes.length && (bytes[position] === 0x20 || bytes[position] === 0x09)) {
    position += 1;
  }
  if (position === bytes.length) {
    return closing ? { closing: true, next: position } : undefined;
  }
  if (!startsWithBytes(bytes, CRLF, position)) return undefined;
  return { closing, next: position + CRLF.length };
}

function parsePartHeaders(bytes: Uint8Array): Map<string, string> {
  let source: string;
  try {
    source = strictUtf8Decoder.decode(bytes);
  } catch {
    throw new MultipartSyntaxError("Multipart part headers must be valid UTF-8.");
  }
  if (source === "") return new Map();

  const lines = source.split("\r\n");
  if (lines.length > MAX_HEADERS_PER_PART) {
    throw new MultipartSyntaxError(
      `Multipart part exceeds the ${MAX_HEADERS_PER_PART}-header limit.`,
    );
  }

  const headers = new Map<string, string>();
  for (const line of lines) {
    if (textEncoder.encode(line).length > MAX_HEADER_LINE_BYTES) {
      throw new MultipartSyntaxError("Multipart part contains an oversized header line.");
    }
    if (line.startsWith(" ") || line.startsWith("\t")) {
      throw new MultipartSyntaxError("Folded multipart headers are not supported.");
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      throw new MultipartSyntaxError("Multipart part contains a malformed header.");
    }
    const name = line.substring(0, colon);
    if (!TOKEN.test(name)) {
      throw new MultipartSyntaxError("Multipart part contains an invalid header name.");
    }
    const lowerName = name.toLowerCase();
    if (headers.has(lowerName)) {
      throw new MultipartSyntaxError(`Multipart part repeats the "${lowerName}" header.`);
    }
    const value = trimOptionalWhitespace(line.substring(colon + 1));
    if (hasInvalidHeaderValueCharacter(value)) {
      throw new MultipartSyntaxError(`Multipart header "${lowerName}" has an invalid value.`);
    }
    headers.set(lowerName, value);
  }
  return headers;
}

function buildParsedPart(
  headers: ReadonlyMap<string, string>,
  body: Uint8Array,
): ParsedMultipartPart {
  const rawContentType = headers.get("content-type");
  const parsedContentType =
    rawContentType === undefined
      ? undefined
      : parseParameterizedValue(rawContentType, "Content-Type");
  const contentType =
    parsedContentType === undefined ? undefined : parseMediaType(parsedContentType.value);
  if (rawContentType !== undefined && contentType === undefined) {
    throw new MultipartSyntaxError("Multipart part has an invalid Content-Type.");
  }

  const rawDisposition = headers.get("content-disposition");
  let disposition: ParsedMultipartDisposition | undefined;
  if (rawDisposition !== undefined) {
    const parsed = parseParameterizedValue(rawDisposition, "Content-Disposition");
    if (!TOKEN.test(parsed.value)) {
      throw new MultipartSyntaxError("Multipart part has an invalid Content-Disposition.");
    }
    const name = parsed.parameters.get("name");
    if (name !== undefined) validateParameter(name, "part name", false);

    const regularFilename = parsed.parameters.get("filename");
    const extendedFilename = parsed.parameters.get("filename*");
    const filename =
      extendedFilename === undefined ? regularFilename : decodeExtendedFilename(extendedFilename);

    disposition = {
      type: parsed.value.toLowerCase(),
      ...(name === undefined ? {} : { name }),
      ...(filename === undefined ? {} : { filename }),
    };
  }

  return {
    headers,
    body,
    ...(contentType === undefined ? {} : { contentType }),
    ...(disposition === undefined ? {} : { disposition }),
  };
}

interface ParameterizedValue {
  readonly value: string;
  readonly parameters: ReadonlyMap<string, string>;
}

function parseParameterizedValue(input: string | null, headerName: string): ParameterizedValue {
  if (input === null || input.length === 0 || hasInvalidHeaderValueCharacter(input)) {
    throw new MultipartSyntaxError(`${headerName} is missing or invalid.`);
  }

  let position = 0;
  position = skipOptionalWhitespace(input, position);
  const valueStart = position;
  while (
    position < input.length &&
    input[position] !== ";" &&
    !isOptionalWhitespace(input[position]!)
  ) {
    position += 1;
  }
  const value = input.substring(valueStart, position);
  if (value.length === 0) {
    throw new MultipartSyntaxError(`${headerName} is invalid.`);
  }
  position = skipOptionalWhitespace(input, position);

  const parameters = new Map<string, string>();
  while (position < input.length) {
    if (input[position] !== ";") {
      throw new MultipartSyntaxError(`${headerName} parameters are malformed.`);
    }
    position = skipOptionalWhitespace(input, position + 1);
    const nameStart = position;
    while (position < input.length && TOKEN.test(input[position]!)) position += 1;
    const name = input.substring(nameStart, position).toLowerCase();
    if (name.length === 0 || !TOKEN.test(name)) {
      throw new MultipartSyntaxError(`${headerName} has an invalid parameter name.`);
    }
    position = skipOptionalWhitespace(input, position);
    if (input[position] !== "=") {
      throw new MultipartSyntaxError(`${headerName} parameter "${name}" is missing "=".`);
    }
    position = skipOptionalWhitespace(input, position + 1);

    let parameterValue: string;
    if (input[position] === '"') {
      const parsed = parseQuotedString(input, position + 1, headerName);
      parameterValue = parsed.value;
      position = parsed.position;
    } else {
      const parameterStart = position;
      while (
        position < input.length &&
        input[position] !== ";" &&
        !isOptionalWhitespace(input[position]!)
      ) {
        position += 1;
      }
      parameterValue = input.substring(parameterStart, position);
      if (!TOKEN.test(parameterValue)) {
        throw new MultipartSyntaxError(`${headerName} parameter "${name}" is invalid.`);
      }
    }
    if (parameterValue.length > MAX_PARAMETER_LENGTH) {
      throw new MultipartSyntaxError(`${headerName} parameter "${name}" is too long.`);
    }
    if (parameters.has(name)) {
      throw new MultipartSyntaxError(`${headerName} repeats parameter "${name}".`);
    }
    parameters.set(name, parameterValue);
    position = skipOptionalWhitespace(input, position);
  }

  return { value, parameters };
}

function parseQuotedString(
  input: string,
  start: number,
  headerName: string,
): { readonly value: string; readonly position: number } {
  let position = start;
  let value = "";
  while (position < input.length) {
    const character = input[position++]!;
    if (character === '"') return { value, position };
    if (character === "\\") {
      if (position >= input.length) {
        throw new MultipartSyntaxError(`${headerName} has an unterminated quoted parameter.`);
      }
      const escaped = input[position++]!;
      if (isControlCharacter(escaped)) {
        throw new MultipartSyntaxError(`${headerName} has an invalid quoted parameter.`);
      }
      value += escaped;
      continue;
    }
    if (isControlCharacter(character)) {
      throw new MultipartSyntaxError(`${headerName} has an invalid quoted parameter.`);
    }
    value += character;
  }
  throw new MultipartSyntaxError(`${headerName} has an unterminated quoted parameter.`);
}

function decodeExtendedFilename(value: string): string {
  const firstTick = value.indexOf("'");
  const secondTick = firstTick === -1 ? -1 : value.indexOf("'", firstTick + 1);
  if (firstTick === -1 || secondTick === -1) {
    throw new MultipartSyntaxError("Multipart filename* parameter is invalid.");
  }
  const charset = value.substring(0, firstTick).toLowerCase();
  if (charset !== "utf-8") {
    throw new MultipartSyntaxError("Multipart filename* must use UTF-8.");
  }
  try {
    return decodeURIComponent(value.substring(secondTick + 1));
  } catch {
    throw new MultipartSyntaxError("Multipart filename* has invalid percent encoding.");
  }
}

export function validateFileName(filename: string): void {
  validateParameter(filename, "filename", true);
  if (filename.includes("/") || filename.includes("\\") || filename === "." || filename === "..") {
    throw new MultipartSyntaxError("Multipart filename must not contain path components.");
  }
}

function validateParameter(value: string, label: string, allowEmpty: boolean): void {
  if ((!allowEmpty && value.length === 0) || value.length > MAX_PARAMETER_LENGTH) {
    throw new MultipartSyntaxError(`Multipart ${label} is invalid.`);
  }
  for (const character of value) {
    if (isControlCharacter(character)) {
      throw new MultipartSyntaxError(`Multipart ${label} contains a control character.`);
    }
  }
}

function hasInvalidHeaderValueCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return true;
  }
  return false;
}

function isControlCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

function isOptionalWhitespace(character: string): boolean {
  return character === " " || character === "\t";
}

function skipOptionalWhitespace(input: string, start: number): number {
  let position = start;
  while (position < input.length && isOptionalWhitespace(input[position]!)) position += 1;
  return position;
}

function trimOptionalWhitespace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isOptionalWhitespace(value[start]!)) start += 1;
  while (end > start && isOptionalWhitespace(value[end - 1]!)) end -= 1;
  return value.substring(start, end);
}

function startsWithBytes(source: Uint8Array, expected: Uint8Array, position: number): boolean {
  if (position < 0 || position + expected.length > source.length) return false;
  for (let index = 0; index < expected.length; index++) {
    if (source[position + index] !== expected[index]) return false;
  }
  return true;
}

function findBytes(source: Uint8Array, needle: Uint8Array, from: number): number {
  if (needle.length === 0) return from;
  const last = source.length - needle.length;
  outer: for (let position = from; position <= last; position++) {
    for (let index = 0; index < needle.length; index++) {
      if (source[position + index] !== needle[index]) continue outer;
    }
    return position;
  }
  return -1;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length);
  result.set(left, 0);
  result.set(right, left.length);
  return result;
}

const CRLF = new Uint8Array([0x0d, 0x0a]);
const DOUBLE_CRLF = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);
const DOUBLE_DASH = new Uint8Array([0x2d, 0x2d]);
