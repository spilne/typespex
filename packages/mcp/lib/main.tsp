import "../dist/tsp-index.js";

namespace TypeSpex.Mcp;

/** An icon advertised in MCP server or tool metadata. */
model McpIcon {
  /** Absolute icon URL. */
  src: url;

  /** Optional media type such as image/png. */
  mimeType?: string;

  /** Optional size labels such as 48x48 or any. */
  sizes?: string[];
}

/** Behavioral hints advertised for a tool. */
model McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** MCP server implementation metadata. */
model McpServerOptions {
  name?: string;
  version: string;
  instructions?: string;
  icons?: McpIcon[];
  websiteUrl?: url;
}

/** MCP tool metadata and annotation overrides. */
model McpToolOptions {
  name?: string;
  title?: string;
  icons?: McpIcon[];
  annotations?: McpToolAnnotations;
}

/** Mark a namespace as an MCP server root. */
extern dec mcpServer(target: TypeSpec.Reflection.Namespace, options: valueof McpServerOptions);

/** Explicitly expose an operation as an MCP tool. */
extern dec tool(target: TypeSpec.Reflection.Operation, options?: valueof McpToolOptions);
