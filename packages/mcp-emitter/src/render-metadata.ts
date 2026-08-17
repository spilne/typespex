import type { McpServerMetadata, McpToolMetadata } from "@typespex/mcp";

export function normalizeIcons(
  icons: McpServerMetadata["icons"] | McpToolMetadata["icons"],
): unknown[] {
  return (icons ?? []).map((icon) => ({
    src: String(icon.src),
    ...(icon.mimeType ? { mimeType: icon.mimeType } : {}),
    ...(icon.sizes ? { sizes: [...icon.sizes] } : {}),
  }));
}
