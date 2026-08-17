import type { Program } from "@typespec/compiler";
import type { HttpPayloadBody } from "@typespec/http";
import type { HttpBodyPlan } from "@typespex/http-client";
import { isBytesLike } from "./http-type-utils.js";

export function bodyKind(
  program: Program,
  body: HttpPayloadBody | undefined,
  contentType: string | undefined,
): HttpBodyPlan["kind"] {
  if (body?.bodyKind === "file") return "file";
  if (body?.bodyKind === "multipart") return "multipart";
  const mediaType = normalizeMediaType(contentType ?? "application/json");
  if (mediaType === "application/jsonl" || mediaType === "application/x-ndjson") return "jsonl";
  if (mediaType === "application/x-www-form-urlencoded") return "form";
  if (mediaType?.startsWith("multipart/")) return "multipart";
  if (mediaType === "application/json" || mediaType?.endsWith("+json")) return "json";
  if (body && isBytesLike(program, body.type)) return "binary";
  if (mediaType === "application/xml" || mediaType === "text/xml" || mediaType?.endsWith("+xml"))
    return "text";
  if (mediaType?.startsWith("text/")) return "text";
  return "binary";
}

export function defaultBodyContentTypes(body: HttpPayloadBody): string[] {
  if (body.bodyKind === "multipart") return ["multipart/form-data"];
  if (body.bodyKind === "file")
    return body.contentTypes.length > 0 ? [...body.contentTypes] : ["application/octet-stream"];
  return ["application/json"];
}

export type HttpValueContext = "value" | "text" | "header" | "binary";

export function httpValueContext(
  program: Program,
  body: HttpPayloadBody,
  contentType: string | undefined,
): HttpValueContext {
  if (body.bodyKind === "file") return "binary";
  const kind = bodyKind(program, body, contentType);
  return kind === "json" || kind === "jsonl"
    ? "value"
    : kind === "binary" || kind === "file"
      ? "binary"
      : "text";
}

export function normalizeMediaType(contentType: string): string {
  return contentType.split(";", 1)[0]!.trim().toLowerCase();
}

export function normalizePathStyle(
  style: "simple" | "label" | "matrix" | "fragment" | "path",
): "simple" | "label" | "matrix" | "path" {
  return style === "label" || style === "matrix" || style === "path" ? style : "simple";
}
