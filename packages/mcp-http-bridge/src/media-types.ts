import type { HttpBridgeBody } from "./contracts.js";

export function extractMediaType(contentType: string | null | undefined): string | undefined {
  if (contentType === null || contentType === undefined) return undefined;
  const separator = contentType.indexOf(";");
  const mediaType = (separator < 0 ? contentType : contentType.slice(0, separator)).trim();
  return mediaType || undefined;
}

export function normalizeMediaType(contentType: string | null | undefined): string | undefined {
  return extractMediaType(contentType)?.toLowerCase();
}

export function mediaTypeMatches(actual: string | undefined, declared: string): boolean {
  const received = normalizeMediaType(actual);
  const expected = normalizeMediaType(declared);
  if (!received || !expected) return false;
  if (expected === "*/*" || expected === received) return true;
  const [expectedType, expectedSubtype] = expected.split("/");
  const [actualType, actualSubtype] = received.split("/");
  const subtypeMatches =
    expectedSubtype === "*" ||
    expectedSubtype === actualSubtype ||
    (expectedSubtype?.startsWith("*+") && actualSubtype?.endsWith(expectedSubtype.slice(1)));
  return (expectedType === "*" || expectedType === actualType) && subtypeMatches;
}

export function defaultContentType(kind: HttpBridgeBody["kind"]): string {
  switch (kind) {
    case "json":
      return "application/json";
    case "form":
      return "application/x-www-form-urlencoded";
    case "multipart":
      return "multipart/form-data";
    case "text":
      return "text/plain; charset=utf-8";
    case "jsonl":
      return "application/jsonl";
    case "binary":
    case "file":
      return "application/octet-stream";
  }
}
