import type { McpIconOptions, McpServerMetadata, McpToolMetadata } from "@typespex/mcp";

export function normalizeIcons(
  icons: McpServerMetadata["icons"] | McpToolMetadata["icons"],
): McpIconOptions[] {
  return (icons ?? []).map((icon) => ({
    src: String(icon.src),
    ...(icon.mimeType ? { mimeType: icon.mimeType } : {}),
    ...(icon.sizes ? { sizes: [...icon.sizes] } : {}),
  }));
}
