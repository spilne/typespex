export type BodyMediaKind = "json" | "form" | "multipart" | "text" | "binary";

/** Maps declared request content types to the decoders that may handle them. */
export function getBodyMediaKinds(contentTypes: readonly string[]): BodyMediaKind[] {
  const kinds = new Set<BodyMediaKind>();

  for (const contentType of contentTypes) {
    const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
    if (mediaType === "*/*") {
      kinds.add("json");
      kinds.add("form");
      kinds.add("multipart");
      kinds.add("text");
      kinds.add("binary");
    } else if (mediaType === "application/*") {
      kinds.add("json");
      kinds.add("form");
      kinds.add("binary");
    } else if (mediaType === "application/json" || mediaType.endsWith("+json")) {
      kinds.add("json");
    } else if (mediaType === "application/x-www-form-urlencoded") {
      kinds.add("form");
    } else if (mediaType.startsWith("multipart/")) {
      kinds.add("multipart");
    } else if (mediaType.startsWith("text/")) {
      kinds.add("text");
    } else {
      kinds.add("binary");
    }
  }

  return [...kinds];
}
