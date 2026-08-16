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
  McpApplicationBase,
  McpToolContext,
  McpToolMiddleware,
  MaybePromise,
  NativeMcpApplication,
} from "./application.js";
import { isMcpToolResult, McpToolError, type McpContent, type McpToolResult } from "./results.js";
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

export interface GeneratedMcpTool<
  Name extends string = string,
  InputWire = any,
  Input = any,
  SuccessWire = any,
  Success = any,
  ErrorWire = any,
  Error = any,
> {
  readonly name: Name;
  readonly handler: Name;
  readonly title?: string;
  readonly description?: string;
  readonly icons?: readonly Icon[];
  readonly annotations?: ToolAnnotations;
  readonly input: TypeSpecSchema<InputWire, Input>;
  readonly success?: TypeSpecSchema<SuccessWire, Success>;
  readonly errors?: TypeSpecSchema<ErrorWire, Error>;
  readonly voidResult?: boolean;
  readonly requiresTaggedResult?: true;
}

/** @internal Execution seam used by protocol bridges without coupling them to the server core. */
export interface McpToolExecutor {
  readonly input: "semantic" | "wire";
  execute(tool: GeneratedMcpTool, input: unknown, context: McpToolContext): MaybePromise<unknown>;
}

/** @internal Server application produced by a protocol bridge. */
export interface ExecutableMcpApplication extends McpApplicationBase {
  readonly kind: "executor";
  readonly executor: McpToolExecutor;
}

export type McpServerApplication<Handlers> =
  | NativeMcpApplication<Handlers>
  | ExecutableMcpApplication;

type SchemaSemantic<Schema> = Schema extends TypeSpecSchema<any, infer Semantic> ? Semantic : never;
type ToolSuccess<Tool extends GeneratedMcpTool> =
  | (Tool extends { readonly success: infer Schema } ? SchemaSemantic<Schema> : never)
  | (Tool extends { readonly voidResult: true } ? void : never);
type ToolError<Tool extends GeneratedMcpTool> = Tool extends { readonly errors: infer Schema }
  ? SchemaSemantic<Schema>
  : never;
type HandlerFor<Tool extends GeneratedMcpTool> = Tool extends {
  readonly requiresTaggedResult: true;
}
  ? McpTaggedToolHandler<SchemaSemantic<Tool["input"]>, ToolSuccess<Tool>, ToolError<Tool>>
  : McpToolHandler<SchemaSemantic<Tool["input"]>, ToolSuccess<Tool>, ToolError<Tool>>;

export type McpHandlersFor<Tools extends readonly GeneratedMcpTool[]> = {
  readonly [Tool in Tools[number] as Tool["handler"]]: HandlerFor<Tool>;
};

export interface GeneratedMcpServerDefinition {
  readonly implementation: Implementation;
  readonly instructions?: string;
  /** @internal Registration seam reserved for generated resources and prompts. */
  readonly registerCapabilities?: readonly ((server: McpServer) => void)[];
}

export function createGeneratedMcpServer<const Tools extends readonly GeneratedMcpTool[]>(
  definition: GeneratedMcpServerDefinition,
  tools: Tools,
  application: McpServerApplication<McpHandlersFor<Tools>>,
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
        inputSchema:
          application.kind === "executor" && application.executor.input === "wire"
            ? tool.input.wire
            : tool.input.input,
        ...(tool.success && !tool.voidResult ? { outputSchema: tool.success.wire } : {}),
        annotations: tool.annotations,
        icons: tool.icons ? [...tool.icons] : undefined,
      },
      async (input, rawContext) => executeTool(tool, input, rawContext, application),
    );
  }
  for (const register of definition.registerCapabilities ?? []) register(server);

  return server;
}

async function executeTool(
  tool: GeneratedMcpTool,
  input: unknown,
  rawContext: ServerContext,
  application: McpServerApplication<Record<string, McpToolHandler<any, any, any>>>,
): Promise<CallToolResult> {
  let context = createToolContext(rawContext);
  try {
    if (application.createContext) context = await application.createContext(context);
    const invoke = async (): Promise<unknown> => {
      if (application.kind === "executor") {
        return application.executor.execute(tool, input, context);
      }
      const handlers = application.handlers as Record<string, unknown>;
      const nativeHandler = Object.hasOwn(handlers, tool.handler)
        ? handlers[tool.handler]
        : undefined;
      if (typeof nativeHandler !== "function") {
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
    try {
      await application.onUnhandledError?.(error, context, tool.name);
    } catch {
      // Error observers cannot replace the sanitized tool response with their own failure.
    }
    return {
      isError: true,
      content: [{ type: "text", text: "Internal tool error." }],
    };
  }
}

const classifiedWireResultTag: unique symbol = Symbol("typespex.classified-wire-result");
/** @internal Classified wire result returned by a generated protocol bridge. */
export interface McpWireToolResult {
  readonly [classifiedWireResultTag]: true;
  readonly kind: "success" | "error";
  readonly value: unknown;
}

/** @internal */
export function mcpWireSuccess(value: unknown): McpWireToolResult {
  return classifiedWireResult("success", value);
}

/** @internal */
export function mcpWireError(value: unknown): McpWireToolResult {
  return classifiedWireResult("error", value);
}

function classifiedWireResult(kind: "success" | "error", value: unknown): McpWireToolResult {
  return { [classifiedWireResultTag]: true, kind, value };
}

function isClassifiedWireResult(value: unknown): value is McpWireToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    classifiedWireResultTag in value &&
    value[classifiedWireResultTag] === true
  );
}

async function normalizeToolResult(
  tool: GeneratedMcpTool,
  value: unknown,
): Promise<CallToolResult> {
  if (isClassifiedWireResult(value)) {
    return normalizeClassifiedWireResult(tool, value);
  }
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

  if (tool.requiresTaggedResult) {
    throw new McpToolError(
      `Tool ${tool.name} has overlapping success and error schemas; return mcpSuccess() or mcpError() explicitly.`,
    );
  }

  const success = tool.success
    ? await tool.success.encode(value, {
        validate: tool.errors !== undefined || tool.voidResult === true,
      })
    : undefined;
  if (success?.ok) return wireSuccess(success.value);
  const error = tool.errors ? await tool.errors.encode(value) : undefined;
  if (error?.ok) return wireError(error.value);
  throw new McpToolError(
    `Tool ${tool.name} returned a value outside its declared TypeSpec result.`,
  );
}

async function normalizeClassifiedWireResult(
  tool: GeneratedMcpTool,
  result: McpWireToolResult,
): Promise<CallToolResult> {
  if (result.kind === "success") {
    if (result.value === undefined && tool.voidResult) {
      return validatedToolResult({ content: [] });
    }
    if (!tool.success) {
      throw new McpToolError(`Tool ${tool.name} has no success output schema.`);
    }
    const validated = await tool.success.validateWire(result.value);
    if (!validated.ok) {
      throw new McpToolError(formatSchemaFailure(tool.name, "success", validated.issues));
    }
    return wireSuccess(validated.value);
  }

  if (!tool.errors) throw new McpToolError(`Tool ${tool.name} declares no modeled errors.`);
  const validated = await tool.errors.validateWire(result.value);
  if (!validated.ok) {
    throw new McpToolError(formatSchemaFailure(tool.name, "error", validated.issues));
  }
  return wireError(validated.value);
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
  const encoded = await tool.success.encode(value, { validate: tool.voidResult === true });
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
    notify: (notification) =>
      raw.mcpReq.notify(notification as Parameters<ServerContext["mcpReq"]["notify"]>[0]),
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
