export type BodyMediaKind = "json" | "xml" | "form" | "multipart" | "file" | "text" | "binary";
export type MultipartPartMediaKind = "json" | "text" | "binary";

const mediaTypeToken = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Normalize one declared media type, ignoring parameters and casing. */
export function normalizeMediaType(contentType: string): string | undefined {
  const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
  const slash = mediaType.indexOf("/");
  if (slash <= 0 || slash !== mediaType.lastIndexOf("/")) {
    return undefined;
  }
  const type = mediaType.slice(0, slash);
  const subtype = mediaType.slice(slash + 1);
  if (!mediaTypeToken.test(type) || !mediaTypeToken.test(subtype)) return undefined;
  return mediaType;
}

export function isJsonMediaType(mediaType: string): boolean {
  if (mediaType === "application/json") return true;
  const slash = mediaType.indexOf("/");
  if (slash < 0) return false;
  const subtype = mediaType.slice(slash + 1);
  return subtype.length > "+json".length && subtype.endsWith("+json");
}

export function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith("text/");
}

export function isXmlMediaType(mediaType: string): boolean {
  if (mediaType === "application/xml" || mediaType === "text/xml") return true;
  const slash = mediaType.indexOf("/");
  if (slash < 0) return false;
  const subtype = mediaType.slice(slash + 1);
  return subtype.length > "+xml".length && subtype.endsWith("+xml");
}

/** Maps declared request content types to the decoders that may handle them. */
export function getBodyMediaKinds(contentTypes: readonly string[]): BodyMediaKind[] {
  const kinds = new Set<BodyMediaKind>();

  for (const contentType of contentTypes) {
    const mediaType = normalizeMediaType(contentType);
    if (!mediaType) continue;
    if (mediaType === "*/*") {
      kinds.add("json");
      kinds.add("xml");
      kinds.add("form");
      kinds.add("multipart");
      kinds.add("text");
      kinds.add("binary");
    } else if (mediaType === "application/*") {
      kinds.add("json");
      kinds.add("xml");
      kinds.add("form");
      kinds.add("binary");
    } else if (mediaType === "text/*") {
      kinds.add("xml");
      kinds.add("text");
    } else if (isJsonMediaType(mediaType)) {
      kinds.add("json");
    } else if (isXmlMediaType(mediaType)) {
      kinds.add("xml");
    } else if (mediaType === "application/x-www-form-urlencoded") {
      kinds.add("form");
    } else if (mediaType.startsWith("multipart/")) {
      kinds.add("multipart");
    } else if (isTextMediaType(mediaType)) {
      kinds.add("text");
    } else {
      kinds.add("binary");
    }
  }

  return [...kinds];
}

/** Maps multipart part content types to the representations supported by the multipart parser. */
export function getMultipartPartMediaKinds(
  contentTypes: readonly string[],
): MultipartPartMediaKind[] {
  const kinds = new Set<MultipartPartMediaKind>();

  for (const contentType of contentTypes) {
    const mediaType = normalizeMediaType(contentType);
    if (!mediaType) continue;
    if (mediaType === "*/*") {
      kinds.add("json");
      kinds.add("text");
      kinds.add("binary");
    } else if (mediaType === "application/*") {
      kinds.add("json");
      kinds.add("binary");
    } else if (mediaType === "text/*") {
      kinds.add("text");
    } else if (isJsonMediaType(mediaType)) {
      kinds.add("json");
    } else if (isTextMediaType(mediaType)) {
      kinds.add("text");
    } else {
      kinds.add("binary");
    }
  }

  return [...kinds];
}
