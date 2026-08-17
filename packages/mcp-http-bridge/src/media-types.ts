import type { HttpBridgeBody } from "./contracts.js";

export function mediaTypeMatches(actual: string | undefined, declared: string): boolean {
  if (!actual) return false;
  const expected = declared.split(";", 1)[0]!.trim().toLowerCase();
  if (expected === "*/*" || expected === actual) return true;
  const [expectedType, expectedSubtype] = expected.split("/");
  const [actualType, actualSubtype] = actual.split("/");
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
