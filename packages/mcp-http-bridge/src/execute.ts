import { McpToolError, type McpToolContext } from "@typespex/mcp-server";
import { resolveCredentials } from "./authentication.js";
import {
  HTTP_BRIDGE_OPERATION_VERSION,
  type HttpBridgeOperation,
  type HttpBridgeResult,
  type McpHttpBridgeOptions,
} from "./contracts.js";
import { applyHttpCredentials, createHttpBridgeRequest, sendHttpBridgeRequest } from "./request.js";
import {
  cancelUpstreamResponse,
  decodeHttpBridgeResponse,
  readUpstreamDiagnostic,
  selectHttpBridgeResponse,
} from "./response.js";
import { normalizeOrigins, resolveUpstreamServer } from "./upstream.js";
import { boundedInteger } from "./errors.js";

/** Executes a generated HTTP bridge operation. Input and output are JSON-wire values. */
export async function executeHttpBridgeTool(
  operation: HttpBridgeOperation,
  input: unknown,
  context: McpToolContext,
  options: McpHttpBridgeOptions,
): Promise<HttpBridgeResult> {
  if (operation.version !== HTTP_BRIDGE_OPERATION_VERSION) {
    throw new McpToolError(
      `Unsupported HTTP bridge operation plan version ${String(operation.version)}.`,
    );
  }

  const baseUrl = await resolveUpstreamServer(operation, input, context, options);
  const allowedOrigins = normalizeOrigins(options.allowedUpstreamOrigins);
  if (allowedOrigins.size > 0 && !allowedOrigins.has(baseUrl.origin)) {
    throw new McpToolError(`Resolved upstream origin ${baseUrl.origin} is not allowed.`);
  }

  const request = createHttpBridgeRequest(baseUrl, operation, input);
  const credentials = await resolveCredentials(operation, input, context, options.authProvider);
  const credentialNames = applyHttpCredentials(request, credentials);

  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new McpToolError("No Fetch implementation is available for the HTTP bridge.");
  }
  const maxRedirects = boundedInteger(options.maxRedirects ?? 3, "maxRedirects", 0);
  const timeoutMs =
    options.timeoutMs === undefined ? undefined : boundedInteger(options.timeoutMs, "timeoutMs", 1);
  const response = await sendHttpBridgeRequest(
    fetchImplementation,
    request.url,
    {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
    },
    context.signal,
    timeoutMs,
    maxRedirects,
    allowedOrigins,
    credentialNames.queryNames,
    credentialNames.headerNames,
  );

  const descriptor = selectHttpBridgeResponse(
    operation.responses,
    response.status,
    response.headers.get("content-type"),
  );
  if (!descriptor) {
    const diagnostic = options.exposeUpstreamDiagnostics
      ? await readUpstreamDiagnostic(response, options.maxDiagnosticBytes, context.signal)
      : "";
    if (!options.exposeUpstreamDiagnostics) await cancelUpstreamResponse(response);
    throw new McpToolError(
      `Upstream returned undeclared HTTP ${response.status}${diagnostic ? `: ${diagnostic}` : "."}`,
    );
  }

  const decoded = await decodeHttpBridgeResponse(response, descriptor, options, context.signal);
  return {
    kind: descriptor.error ? "error" : "success",
    value: decoded,
    status: response.status,
  };
}
