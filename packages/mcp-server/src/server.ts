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
import {
  isMcpToolError,
  isMcpToolResult,
  McpToolError,
  type McpContent,
  type McpToolResult,
} from "./results.js";
import type { Schema } from "./schema.js";

export type McpToolHandler<
  Input,
  Success,
  Error = never,
  Context extends McpToolContext = McpToolContext,
> = (
  input: Input,
  context: Context,
) => MaybePromise<Success | Error | McpToolResult<Success, Error> | McpToolError>;

/** Handler form emitted when success and error wire contracts overlap. */
export type McpTaggedToolHandler<
  Input,
  Success,
  Error,
  Context extends McpToolContext = McpToolContext,
> = (input: Input, context: Context) => MaybePromise<McpToolResult<Success, Error> | McpToolError>;

export interface McpToolDefinition<
  Name extends string = string,
  InputWire = unknown,
  Input = unknown,
  SuccessWire = unknown,
  Success = unknown,
  ErrorWire = unknown,
  Error = unknown,
> {
  readonly name: Name;
  readonly title?: string;
  readonly description?: string;
  readonly icons?: readonly Icon[];
  readonly annotations?: ToolAnnotations;
  readonly input: Schema<InputWire, Input>;
  readonly success?: Schema<SuccessWire, Success>;
  readonly errors?: Schema<ErrorWire, Error>;
  readonly voidResult?: boolean;
  readonly requiresTaggedResult?: true;
}

/** @internal Execution seam used by protocol bridges without coupling them to the server core. */
export interface McpToolExecutor {
  readonly input: "semantic" | "wire";
  execute(tool: McpToolDefinition, input: unknown, context: McpToolContext): MaybePromise<unknown>;
}

/** @internal Server application produced by a protocol bridge. */
export interface ExecutableMcpApplication<
  Context extends McpToolContext = McpToolContext,
> extends McpApplicationBase<Context> {
  readonly kind: "executor";
  readonly executor: McpToolExecutor;
}

export type McpServerApplication<Handlers, Context extends McpToolContext = McpToolContext> =
  | NativeMcpApplication<Handlers, Context>
  | ExecutableMcpApplication<Context>;

type SchemaSemantic<SchemaType> = SchemaType extends Schema<any, infer Semantic> ? Semantic : never;
type ToolSuccess<Tool extends McpToolDefinition> =
  | (Tool extends { readonly success: infer Schema } ? SchemaSemantic<Schema> : never)
  | (Tool extends { readonly voidResult: true } ? void : never);
type ToolError<Tool extends McpToolDefinition> = Tool extends {
  readonly errors: infer SchemaType;
}
  ? SchemaSemantic<SchemaType>
  : never;
type HandlerFor<Tool extends McpToolDefinition, Context extends McpToolContext> = Tool extends {
  readonly requiresTaggedResult: true;
}
  ? McpTaggedToolHandler<SchemaSemantic<Tool["input"]>, ToolSuccess<Tool>, ToolError<Tool>, Context>
  : McpToolHandler<SchemaSemantic<Tool["input"]>, ToolSuccess<Tool>, ToolError<Tool>, Context>;

export type McpHandlersFor<
  Tools extends readonly McpToolDefinition[],
  Context extends McpToolContext = McpToolContext,
> = {
  readonly [Tool in Tools[number] as Tool["name"]]: HandlerFor<Tool, Context>;
};

export interface McpServerDefinition {
  readonly implementation: Implementation;
  readonly instructions?: string;
}

export function createMcpServer<
  const Tools extends readonly McpToolDefinition[],
  Context extends McpToolContext = McpToolContext,
>(
  definition: McpServerDefinition,
  tools: Tools,
  application: McpServerApplication<McpHandlersFor<Tools, Context>, Context>,
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
  return server;
}

async function executeTool(
  tool: McpToolDefinition,
  input: unknown,
  rawContext: ServerContext,
  application: McpServerApplication<Record<string, McpToolHandler<any, any, any, any>>, any>,
): Promise<CallToolResult> {
  let context = createToolContext(rawContext);
  try {
    if (application.createContext) context = await application.createContext(context);
    const invoke = async (): Promise<unknown> => {
      if (application.kind === "executor") {
        return application.executor.execute(tool, input, context);
      }
      const handlers = application.handlers as Record<string, unknown>;
      const nativeHandler = Object.hasOwn(handlers, tool.name) ? handlers[tool.name] : undefined;
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
    if (isMcpToolError(error)) return operationalErrorResult(error);
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

const classifiedWireResultTag = Symbol.for("@typespex/mcp-server/wire-result");
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
    (value as Record<PropertyKey, unknown>)[classifiedWireResultTag] === true
  );
}

async function normalizeToolResult(
  tool: McpToolDefinition,
  value: unknown,
): Promise<CallToolResult> {
  if (isClassifiedWireResult(value)) {
    return normalizeClassifiedWireResult(tool, value);
  }
  if (isMcpToolError(value)) return operationalErrorResult(value);
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
  tool: McpToolDefinition,
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
  tool: McpToolDefinition,
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
  tool: McpToolDefinition,
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
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (cause) {
    throw new McpToolError("Tool result could not be serialized as JSON.", { cause });
  }
  return text === undefined ? [] : [{ type: "text", text }];
}

async function runMiddleware(
  tool: string,
  input: unknown,
  context: McpToolContext,
  middleware: readonly McpToolMiddleware<any>[],
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
