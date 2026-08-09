const HEX = /^[0-9A-Fa-f]{2}$/;

/** One raw path segment paired with its canonical matcher representation. */
export interface CanonicalPathSegment {
  readonly raw: string;
  readonly value: string;
  /** Canonical UTF-16 boundary index to raw UTF-16 boundary index. */
  readonly rawOffsets: readonly number[];
}

/** A structurally parsed pathname whose segments have been canonicalized independently. */
export interface CanonicalPathname {
  readonly raw: string;
  readonly value: string;
  readonly segments: readonly CanonicalPathSegment[];
  readonly trailingSlash: boolean;
  /** Canonical UTF-16 boundary index to raw UTF-16 boundary index. */
  readonly rawOffsets: readonly number[];
}

interface CanonicalBuilder {
  readonly chunks: string[];
  readonly rawOffsets: number[];
  length: number;
}

function createBuilder(rawStart = 0): CanonicalBuilder {
  return { chunks: [], rawOffsets: [rawStart], length: 0 };
}

function appendMapped(
  builder: CanonicalBuilder,
  value: string,
  rawStart: number,
  rawEnd: number,
): void {
  builder.rawOffsets[builder.length] = rawStart;
  builder.chunks.push(value);
  for (let index = 1; index < value.length; index++) {
    // Unicode-aware matcher regexes never split a scalar value. Keeping an
    // interior offset makes the map total even for supplementary characters.
    builder.rawOffsets[builder.length + index] = rawStart;
  }
  builder.length += value.length;
  builder.rawOffsets[builder.length] = rawEnd;
}

function appendIdentity(builder: CanonicalBuilder, value: string, rawStart: number): void {
  for (let index = 0; index < value.length; index++) {
    appendMapped(builder, value[index]!, rawStart + index, rawStart + index + 1);
  }
}

function percentByte(value: string, index: number): number | undefined {
  if (value[index] !== "%") return undefined;
  const digits = value.slice(index + 1, index + 3);
  return HEX.test(digits) ? Number.parseInt(digits, 16) : undefined;
}

function isUnreserved(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    (byte >= 0x30 && byte <= 0x39) ||
    byte === 0x2d ||
    byte === 0x2e ||
    byte === 0x5f ||
    byte === 0x7e
  );
}

function utf8Length(first: number): number | undefined {
  if (first >= 0xc2 && first <= 0xdf) return 2;
  if (first >= 0xe0 && first <= 0xef) return 3;
  if (first >= 0xf0 && first <= 0xf4) return 4;
  return undefined;
}

function decodeUtf8Escapes(
  value: string,
  index: number,
  first: number,
): { readonly value: string; readonly end: number } | undefined {
  const length = utf8Length(first);
  if (length === undefined) return undefined;

  const bytes = [first];
  for (let offset = 1; offset < length; offset++) {
    const byte = percentByte(value, index + offset * 3);
    if (byte === undefined || byte < 0x80 || byte > 0xbf) return undefined;
    bytes.push(byte);
  }

  const second = bytes[1]!;
  if (
    (first === 0xe0 && second < 0xa0) ||
    (first === 0xed && second > 0x9f) ||
    (first === 0xf0 && second < 0x90) ||
    (first === 0xf4 && second > 0x8f)
  ) {
    return undefined;
  }

  let codePoint: number;
  if (length === 2) {
    codePoint = ((first & 0x1f) << 6) | (second & 0x3f);
  } else if (length === 3) {
    codePoint = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (bytes[2]! & 0x3f);
  } else {
    codePoint =
      ((first & 0x07) << 18) |
      ((second & 0x3f) << 12) |
      ((bytes[2]! & 0x3f) << 6) |
      (bytes[3]! & 0x3f);
  }
  return { value: String.fromCodePoint(codePoint), end: index + length * 3 };
}

/**
 * Canonicalizes URI spelling without changing path structure.
 *
 * Percent-encoded unreserved ASCII and valid UTF-8 Unicode become their
 * literal form. All remaining valid escapes stay escaped with uppercase hex,
 * which keeps reserved delimiters distinct from encoded parameter data.
 * Malformed escapes remain untouched so a parameter decoder can report them.
 */
export function canonicalizePathSegment(raw: string): CanonicalPathSegment {
  const builder = createBuilder();
  let index = 0;
  while (index < raw.length) {
    const byte = percentByte(raw, index);
    if (byte === undefined) {
      appendMapped(builder, raw[index]!, index, index + 1);
      index += 1;
      continue;
    }

    if (isUnreserved(byte)) {
      appendMapped(builder, String.fromCharCode(byte), index, index + 3);
      index += 3;
      continue;
    }

    if (byte >= 0x80) {
      const decoded = decodeUtf8Escapes(raw, index, byte);
      if (decoded) {
        appendMapped(builder, decoded.value, index, decoded.end);
        index = decoded.end;
        continue;
      }
    }

    appendIdentity(builder, `%${raw.slice(index + 1, index + 3).toUpperCase()}`, index);
    index += 3;
  }

  return {
    raw,
    value: builder.chunks.join(""),
    rawOffsets: builder.rawOffsets,
  };
}

/** Canonical form used for route literals and registration conflict keys. */
export function canonicalizeRouteLiteral(value: string): string {
  return canonicalizePathSegment(value).value;
}

/** Splits only on literal slashes, then canonicalizes each segment independently. */
export function canonicalizePathname(pathname: string): CanonicalPathname | undefined {
  if (pathname === "/") {
    return {
      raw: pathname,
      value: pathname,
      segments: [],
      trailingSlash: true,
      rawOffsets: [0, 1],
    };
  }
  if (!pathname.startsWith("/")) return undefined;

  const trailingSlash = pathname.endsWith("/");
  const end = trailingSlash ? pathname.length - 1 : pathname.length;
  if (end <= 1) return undefined;
  const rawSegments = pathname.substring(1, end).split("/");
  if (rawSegments.some((segment) => segment.length === 0)) return undefined;

  const segments = rawSegments.map(canonicalizePathSegment);
  const builder = createBuilder();
  let rawOffset = 0;
  for (const segment of segments) {
    appendMapped(builder, "/", rawOffset, rawOffset + 1);
    rawOffset += 1;
    const canonicalStart = builder.length;
    builder.chunks.push(segment.value);
    for (let index = 0; index < segment.rawOffsets.length; index++) {
      builder.rawOffsets[canonicalStart + index] = rawOffset + segment.rawOffsets[index]!;
    }
    builder.length += segment.value.length;
    rawOffset += segment.raw.length;
  }
  if (trailingSlash) {
    appendMapped(builder, "/", rawOffset, rawOffset + 1);
  }

  return {
    raw: pathname,
    value: builder.chunks.join(""),
    segments,
    trailingSlash,
    rawOffsets: builder.rawOffsets,
  };
}

export function rawPathSlice(
  pathname: CanonicalPathname,
  canonicalStart: number,
  canonicalEnd: number,
): string {
  return pathname.raw.slice(
    pathname.rawOffsets[canonicalStart]!,
    pathname.rawOffsets[canonicalEnd]!,
  );
}

export function rawSegmentSlice(
  segment: CanonicalPathSegment,
  canonicalStart: number,
  canonicalEnd: number,
): string {
  return segment.raw.slice(segment.rawOffsets[canonicalStart]!, segment.rawOffsets[canonicalEnd]!);
}
