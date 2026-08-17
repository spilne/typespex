import { McpToolError } from "@typespex/mcp-server";
import { isRecord } from "./value-paths.js";

export interface FileRecord {
  readonly name: string;
  readonly data: string;
  readonly mediaType?: string;
}

export function asFileRecord(value: unknown): FileRecord {
  if (!isFileRecord(value)) throw new McpToolError("Expected a JSON file record.");
  return value;
}

export function isFileRecord(value: unknown): value is FileRecord {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.data === "string" &&
    (value.mediaType === undefined || typeof value.mediaType === "string")
  );
}

export function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new McpToolError("Expected valid base64 data.");
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeBase64(value: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...value.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(""));
}

export function asBodyBytes(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

export async function fileToRecord(file: File): Promise<FileRecord> {
  return {
    name: file.name,
    ...(file.type ? { mediaType: file.type } : {}),
    data: encodeBase64(new Uint8Array(await file.arrayBuffer())),
  };
}

export function responseFileName(disposition: string | null): string | undefined {
  if (!disposition) return undefined;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (utf8) {
    try {
      return decodeURIComponent(utf8);
    } catch {
      return undefined;
    }
  }
  return (
    /filename="([^"]+)"/i.exec(disposition)?.[1] ??
    /filename=([^;]+)/i.exec(disposition)?.[1]?.trim()
  );
}
