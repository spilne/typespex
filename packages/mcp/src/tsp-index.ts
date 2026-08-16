import { $mcpServer, $tool } from "./decorators.js";

export { $lib } from "./lib.js";

/** @internal TypeSpec decorator implementation table. */
export const $decorators = {
  "TypeSpex.Mcp": {
    mcpServer: $mcpServer,
    tool: $tool,
  },
};
