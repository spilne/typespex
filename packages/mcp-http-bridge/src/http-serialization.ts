import { McpToolError } from "@typespex/mcp-server";

export function splitHttpList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return String(value);
  if (value === null) return "";
  throw new McpToolError(
    `Expected an HTTP scalar, received ${Array.isArray(value) ? "array" : typeof value}.`,
  );
}

export function objectPairs(value: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(value).flatMap(([key, item]) => [key, scalar(item)]);
}
