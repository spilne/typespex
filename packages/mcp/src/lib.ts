import { createTypeSpecLibrary, paramMessage, type JSONSchemaType } from "@typespec/compiler";

export type McpMode = "native" | "http-bridge";
export type McpLauncher = "stdio" | "node" | "bun" | "express" | "hono";

export interface McpEmitterOptions {
  /** A unique, non-empty selection of generation modes. */
  readonly mode?: readonly McpMode[];
  readonly "application-module"?: string;
  readonly launchers?: readonly McpLauncher[];
  readonly "service-output"?: "auto" | "flat" | "prefix" | "directory";
  readonly "service-folder-pattern"?: string;
  readonly "file-name-pattern"?: string;
  readonly "datetime-mode"?: "string" | "date" | "temporal";
}

const emitterOptionsSchema: JSONSchemaType<McpEmitterOptions> = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: {
      type: "array",
      items: { type: "string", enum: ["native", "http-bridge"] },
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
      nullable: true,
    },
    "application-module": { type: "string", nullable: true },
    launchers: {
      type: "array",
      items: { type: "string", enum: ["stdio", "node", "bun", "express", "hono"] },
      nullable: true,
    },
    "service-output": {
      type: "string",
      enum: ["auto", "flat", "prefix", "directory"],
      nullable: true,
    },
    "service-folder-pattern": { type: "string", nullable: true },
    "file-name-pattern": { type: "string", nullable: true },
    "datetime-mode": {
      type: "string",
      enum: ["string", "date", "temporal"],
      nullable: true,
    },
  },
  required: [],
};

export const $lib = createTypeSpecLibrary({
  name: "@typespex/mcp",
  diagnostics: {
    "no-mcp-servers": {
      severity: "warning",
      messages: { default: "No namespaces decorated with @mcpServer were found." },
    },
    "no-tools": {
      severity: "warning",
      messages: { default: "MCP server contains no operations decorated with @tool." },
    },
    "tool-outside-server": {
      severity: "error",
      messages: { default: "@tool operation is not contained by an @mcpServer namespace." },
    },
    "duplicate-tool-name": {
      severity: "error",
      messages: {
        default: paramMessage`MCP tools "${"first"}" and "${"second"}" both use the name "${"name"}". Configure an explicit unique @tool name.`,
      },
    },
    "invalid-tool-name": {
      severity: "error",
      messages: {
        default: paramMessage`MCP tool name "${"name"}" is invalid. Use 1-128 ASCII letters, digits, underscore, hyphen, or period, excluding reserved object property names.`,
      },
    },
    "ambiguous-tool-result": {
      severity: "warning",
      messages: {
        default: paramMessage`MCP tool "${"name"}" has overlapping success and error wire schemas. Its handlers must return a tagged McpToolResult because ordinary values are ambiguous.`,
      },
    },
    "missing-application-module": {
      severity: "error",
      messages: {
        default:
          "application-module is required when MCP launchers are enabled; set launchers to [] for library-only generation.",
      },
    },
    "application-module-needs-service-token": {
      severity: "error",
      messages: {
        default:
          "application-module must contain {service} when more than one MCP server is emitted.",
      },
    },
    "bridge-requires-service": {
      severity: "error",
      messages: {
        default: "HTTP bridge generation requires every @mcpServer namespace to also use @service.",
      },
    },
    "bridge-operation-missing": {
      severity: "error",
      messages: {
        default: paramMessage`MCP tool "${"name"}" has no HTTP binding in its enclosing service.`,
      },
    },
    "bridge-http-library-missing": {
      severity: "error",
      messages: {
        default: "HTTP bridge generation requires @typespec/http 1.14 or newer.",
      },
    },
    "bridge-unsupported": {
      severity: "error",
      messages: {
        default: paramMessage`HTTP bridge operation "${"name"}" uses an unsupported contract: ${"message"}.`,
      },
    },
    "codegen-error": {
      severity: "error",
      messages: { default: paramMessage`${"message"}` },
    },
    "duplicate-output-path": {
      severity: "error",
      messages: { default: paramMessage`${"message"}` },
    },
    "generated-format-error": {
      severity: "error",
      messages: { default: paramMessage`${"message"}` },
    },
  },
  emitter: { options: emitterOptionsSchema },
} as const);

export const { createStateSymbol } = $lib;
