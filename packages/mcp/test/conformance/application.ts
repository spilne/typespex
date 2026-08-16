import { McpToolError, mcpSuccess } from "@typespex/mcp-runtime";
import { defineConformanceToolsMcpApplication } from "./mcp-server.js";

const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4WQAAAAASUVORK5CYII=";
const wave = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

export default defineConformanceToolsMcpApplication({
  http: {
    port: Number.parseInt(
      (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
        ?.TYPESPEX_MCP_CONFORMANCE_PORT ?? "3000",
      10,
    ),
  },
  handlers: {
    test_simple_text() {
      return mcpSuccess("simple text", {
        content: [{ type: "text", text: "This is a simple text response for testing." }],
      });
    },

    test_image_content() {
      return mcpSuccess("image", {
        content: [{ type: "image", data: pixel, mimeType: "image/png" }],
      });
    },

    test_audio_content() {
      return mcpSuccess("audio", {
        content: [{ type: "audio", data: wave, mimeType: "audio/wav" }],
      });
    },

    test_embedded_resource() {
      return mcpSuccess("resource", {
        content: [
          {
            type: "resource",
            resource: {
              uri: "test://embedded-resource",
              mimeType: "text/plain",
              text: "This is an embedded resource content.",
            },
          },
        ],
      });
    },

    test_multiple_content_types() {
      return mcpSuccess("mixed", {
        content: [
          { type: "text", text: "Multiple content types test:" },
          { type: "image", data: pixel, mimeType: "image/png" },
          {
            type: "resource",
            resource: {
              uri: "test://mixed-content-resource",
              mimeType: "application/json",
              text: JSON.stringify({ test: "data", value: 123 }),
            },
          },
        ],
      });
    },

    test_error_handling() {
      return new McpToolError("This tool intentionally returns an error for testing");
    },

    async test_tool_with_progress(_input, context) {
      await context.reportProgress(0, 100);
      await context.reportProgress(50, 100);
      await context.reportProgress(100, 100);
      return "progress complete";
    },

    json_schema_2020_12_tool() {
      return "schema preserved";
    },
  },
});
