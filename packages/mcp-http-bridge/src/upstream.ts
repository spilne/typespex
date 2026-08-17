import { McpToolError } from "@typespex/mcp-server";
import type { McpToolContext } from "@typespex/mcp-server";
import type { HttpBridgeOperation, McpHttpBridgeOptions } from "./contracts.js";

const EMPTY_ORIGINS: ReadonlySet<string> = new Set();
const normalizedOriginsCache = new WeakMap<
  readonly string[],
  { readonly signature: string; readonly origins: ReadonlySet<string> }
>();

export async function resolveUpstreamServer(
  operation: HttpBridgeOperation,
  input: unknown,
  context: McpToolContext,
  options: McpHttpBridgeOptions,
): Promise<URL> {
  if (options.server !== undefined && options.resolveServer !== undefined) {
    throw new McpToolError("Configure either bridge.server or bridge.resolveServer, not both.");
  }
  let resolved: string | URL | undefined = options.server;
  if (!resolved && options.resolveServer) {
    if (!options.allowedUpstreamOrigins?.length) {
      throw new McpToolError("Dynamic upstream server resolution requires allowedUpstreamOrigins.");
    }
    resolved = await options.resolveServer({ operation, input, context });
  }
  resolved ??=
    operation.servers?.length === 1 && operation.servers[0]?.fullyDefaulted
      ? operation.servers[0].url
      : undefined;
  if (!resolved) {
    throw new McpToolError(
      `No upstream server is resolvable for ${operation.id}; configure bridge.server or bridge.resolveServer.`,
    );
  }
  let url: URL;
  try {
    url = new URL(resolved);
  } catch (error) {
    throw new McpToolError(
      `Invalid upstream server URL for ${operation.id}; expected an absolute HTTP(S) URL.`,
      { cause: error },
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new McpToolError(`Unsupported upstream URL scheme ${url.protocol}.`);
  }
  if (url.username || url.password)
    throw new McpToolError("Upstream URLs must not contain credentials.");
  return url;
}

export function normalizeOrigins(origins: readonly string[] | undefined): ReadonlySet<string> {
  if (!origins) return EMPTY_ORIGINS;
  const signature = JSON.stringify(origins);
  const cached = normalizedOriginsCache.get(origins);
  if (cached?.signature === signature) return cached.origins;
  const output = new Set<string>();
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch (error) {
      throw new McpToolError(`Invalid allowed upstream origin ${JSON.stringify(origin)}.`, {
        cause: error,
      });
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new McpToolError(
        `Allowed upstream origin ${JSON.stringify(origin)} must use HTTP or HTTPS.`,
      );
    }
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
      throw new McpToolError(`Expected an upstream origin, received ${origin}.`);
    }
    output.add(url.origin);
  }
  normalizedOriginsCache.set(origins, { signature, origins: output });
  return output;
}
