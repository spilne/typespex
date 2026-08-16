import {
  isCallToolResult,
  McpServer,
  type CallToolResult,
  type Icon,
  type Implementation,
  type ServerContext,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import type {
  McpApplication,
  McpToolContext,
  McpToolMiddleware,
  MaybePromise,
} from "./application.js";
import {
  executeHttpBridgeTool,
  type HttpBridgeOperation,
  type McpHttpBridgeOptions,
} from "./http-bridge.js";
import {
  isMcpToolResult,
  mcpError,
  mcpSuccess,
  McpToolError,
  type McpContent,
  type McpToolResult,
} from "./results.js";
import type { TypeSpecSchema } from "./schema.js";

export type McpToolHandler<Input, Success, Error = never> = (
  input: Input,
  context: McpToolContext,
) => MaybePromise<Success | Error | McpToolResult<Success, Error> | McpToolError>;

/** Handler form emitted when success and error wire contracts overlap. */
export type McpTaggedToolHandler<Input, Success, Error> = (
  input: Input,
  context: McpToolContext,
) => MaybePromise<McpToolResult<Success, Error> | McpToolError>;

export interface GeneratedMcpTool {
  readonly name: string;
  readonly handler: string;
  readonly title?: string;
  readonly description?: string;
  readonly icons?: readonly Icon[];
  readonly annotations?: ToolAnnotations;
  readonly input: TypeSpecSchema;
  readonly success?: TypeSpecSchema;
  readonly errors?: TypeSpecSchema;
  readonly voidResult?: boolean;
  readonly http?: HttpBridgeOperation;
}

export interface GeneratedMcpServerDefinition {
  readonly implementation: Implementation;
  readonly instructions?: string;
  /** @internal Registration seam reserved for generated resources and prompts. */
  readonly registerCapabilities?: readonly ((server: McpServer) => void)[];
}

export function createGeneratedMcpServer<Handlers>(
  definition: GeneratedMcpServerDefinition,
  tools: readonly GeneratedMcpTool[],
  application: McpApplication<Handlers>,
): McpServer {
  const server = new McpServer(definition.implementation, {
    instructions: definition.instructions,
    capabilities: { tools: { listChanged: false }, logging: {} },
  });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input.input,
        ...(tool.success ? { outputSchema: tool.success.wire } : {}),
        annotations: tool.annotations,
        icons: tool.icons ? [...tool.icons] : undefined,
      },
      async (input, rawContext) => executeTool(tool, input, rawContext, application),
    );
  }
  for (const register of definition.registerCapabilities ?? []) register(server);

  return server;
}

async function executeTool<Handlers>(
  tool: GeneratedMcpTool,
  input: unknown,
  rawContext: ServerContext,
  application: McpApplication<Handlers>,
): Promise<CallToolResult> {
  let context = createToolContext(rawContext);
  if (application.createContext) context = await application.createContext(context);

  try {
    const invoke = async (): Promise<unknown> => {
      const handlers = application.handlers as Record<string, unknown> | undefined;
      const nativeHandler =
        handlers && Object.hasOwn(handlers, tool.handler) ? handlers[tool.handler] : undefined;
      const useBridge =
        application.kind === "http-bridge" ||
        (application.kind === "hybrid" && application.execution === "http-bridge");
      if (useBridge && tool.http) {
        return executeBridgeTool(tool, input, context, application.bridge);
      }
      if (typeof nativeHandler !== "function") {
        if (tool.http && "bridge" in application) {
          return executeBridgeTool(tool, input, context, application.bridge);
        }
        throw new McpToolError(`No handler is configured for tool ${tool.name}.`);
      }
      return (nativeHandler as (value: unknown, context: McpToolContext) => MaybePromise<unknown>)(
        input,
        context,
      );
    };
    const value = await runMiddleware(
      tool.name,
      input,
      context,
      application.middleware ?? [],
      invoke,
    );
    return normalizeToolResult(tool, value);
  } catch (error) {
    if (error instanceof McpToolError) return operationalErrorResult(error);
    await application.onUnhandledError?.(error, context, tool.name);
    return {
      isError: true,
      content: [{ type: "text", text: "Internal tool error." }],
    };
  }
}

async function executeBridgeTool(
  tool: GeneratedMcpTool,
  input: unknown,
  context: McpToolContext,
  options: McpHttpBridgeOptions,
): Promise<unknown> {
  const encodedInput = await tool.input.encode(input);
  if (!encodedInput.ok) {
    throw new McpToolError(formatSchemaFailure(tool.name, "input", encodedInput.issues));
  }
  const result = await executeHttpBridgeTool(tool.http!, encodedInput.value, context, options);
  if (result.kind === "success") {
    if (!tool.success) {
      if (tool.voidResult && result.value === undefined) return mcpSuccess(undefined);
      throw new McpToolError(`Upstream returned a body for void tool ${tool.name}.`);
    }
    const decoded = await tool.success.input["~standard"].validate(result.value);
    if (decoded.issues) {
      throw new McpToolError(formatSchemaFailure(tool.name, "success", decoded.issues));
    }
    return mcpSuccess(decoded.value);
  }
  if (!tool.errors) {
    throw new McpToolError(
      `Upstream returned modeled HTTP error ${result.status} for ${tool.name}.`,
    );
  }
  const decoded = await tool.errors.input["~standard"].validate(result.value);
  if (decoded.issues) {
    throw new McpToolError(formatSchemaFailure(tool.name, "error", decoded.issues));
  }
  return mcpError(decoded.value);
}

async function normalizeToolResult(
  tool: GeneratedMcpTool,
  value: unknown,
): Promise<CallToolResult> {
  if (value instanceof McpToolError) return operationalErrorResult(value);
  if (isMcpToolResult(value)) {
    return value.kind === "success"
      ? encodeSuccess(tool, value.value, value.content)
      : encodeError(tool, value.value, value.content);
  }

  if (value === undefined && (tool.voidResult || (!tool.success && !tool.errors))) {
    return validatedToolResult({ content: [] });
  }

  if (!tool.success && !tool.errors) {
    throw new McpToolError(`Tool ${tool.name} declares no result but returned a value.`);
  }

  const [success, error] = await Promise.all([
    tool.success ? tool.success.encode(value) : Promise.resolve(undefined),
    tool.errors ? tool.errors.encode(value) : Promise.resolve(undefined),
  ]);
  const successMatches = success?.ok === true;
  const errorMatches = error?.ok === true;
  if (successMatches && errorMatches) {
    throw new McpToolError(
      `Tool ${tool.name} returned a value matching both success and error schemas; return mcpSuccess() or mcpError() explicitly.`,
    );
  }
  if (successMatches) return wireSuccess(success.value);
  if (errorMatches) return wireError(error.value);
  throw new McpToolError(
    `Tool ${tool.name} returned a value outside its declared TypeSpec result.`,
  );
}

async function encodeSuccess(
  tool: GeneratedMcpTool,
  value: unknown,
  content?: McpContent,
): Promise<CallToolResult> {
  if (value === undefined && tool.voidResult) {
    return validatedToolResult({ content: content ?? [] });
  }
  if (!tool.success) {
    if (value !== undefined)
      throw new McpToolError(`Tool ${tool.name} has no success output schema.`);
    return validatedToolResult({ content: content ?? [] });
  }
  const encoded = await tool.success.encode(value);
  if (!encoded.ok)
    throw new McpToolError(formatSchemaFailure(tool.name, "success", encoded.issues));
  return wireSuccess(encoded.value, content);
}

async function encodeError(
  tool: GeneratedMcpTool,
  value: unknown,
  content?: McpContent,
): Promise<CallToolResult> {
  if (!tool.errors) throw new McpToolError(`Tool ${tool.name} declares no modeled errors.`);
  const encoded = await tool.errors.encode(value);
  if (!encoded.ok) throw new McpToolError(formatSchemaFailure(tool.name, "error", encoded.issues));
  return wireError(encoded.value, content);
}

function wireSuccess(value: unknown, content?: McpContent): CallToolResult {
  return validatedToolResult({
    content: content ?? jsonTextContent(value),
    structuredContent: value,
  });
}

function wireError(value: unknown, content?: McpContent): CallToolResult {
  return validatedToolResult({
    isError: true,
    content: content ?? jsonTextContent(value),
    structuredContent: value,
  });
}

function operationalErrorResult(error: McpToolError): CallToolResult {
  return validatedToolResult({
    isError: true,
    content: error.options.content ?? [{ type: "text", text: error.message }],
  });
}

function validatedToolResult(value: unknown): CallToolResult {
  if (!isCallToolResult(value)) {
    throw new McpToolError("Tool result contains invalid MCP rich content or structured data.");
  }
  return value;
}

function jsonTextContent(value: unknown): McpContent {
  const text = JSON.stringify(value);
  return text === undefined ? [] : [{ type: "text", text }];
}

async function runMiddleware(
  tool: string,
  input: unknown,
  context: McpToolContext,
  middleware: readonly McpToolMiddleware[],
  invoke: () => Promise<unknown>,
): Promise<unknown> {
  let index = -1;
  const dispatch = async (nextIndex: number): Promise<unknown> => {
    if (nextIndex <= index) throw new Error("MCP middleware called next() more than once.");
    index = nextIndex;
    const current = middleware[nextIndex];
    return current ? current({ tool, input, context }, () => dispatch(nextIndex + 1)) : invoke();
  };
  return dispatch(0);
}

function createToolContext(raw: ServerContext): McpToolContext {
  const requestId = raw.mcpReq.id;
  return {
    requestId,
    requestMeta: raw.mcpReq._meta,
    signal: raw.mcpReq.signal,
    authInfo: raw.http?.authInfo,
    raw,
    notify: raw.mcpReq.notify,
    log: (level, data, logger) => raw.mcpReq.log(level, data, logger),
    async reportProgress(progress, total, message): Promise<void> {
      const progressToken = raw.mcpReq._meta?.progressToken;
      if (progressToken === undefined) return;
      await raw.mcpReq.notify({
        method: "notifications/progress",
        params: {
          progressToken,
          progress,
          ...(total === undefined ? {} : { total }),
          ...(message === undefined ? {} : { message }),
        },
      });
    },
  };
}

function formatSchemaFailure(
  tool: string,
  kind: "input" | "success" | "error",
  issues: readonly {
    readonly message: string;
    readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[];
  }[],
): string {
  const details = issues
    .map(
      (issue) =>
        `${issue.path?.map((segment) => String(typeof segment === "object" ? segment.key : segment)).join(".") || "$"}: ${issue.message}`,
    )
    .join("; ");
  return `Tool ${tool} returned invalid ${kind} output: ${details}`;
}
