import type { AuthInfo, ServerContext } from "@modelcontextprotocol/server";
import type { McpHttpBridgeOptions } from "./http-bridge.js";
import type { McpHttpServerOptions } from "./http.js";

export type MaybePromise<T> = T | Promise<T>;

export interface McpStdioOptions {
  readonly legacy?: "serve" | "reject";
  readonly onError?: (error: Error) => void;
}

export interface McpToolContext {
  readonly requestId: string | number;
  readonly requestMeta?: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  readonly authInfo?: AuthInfo;
  readonly raw: ServerContext;
  readonly notify: ServerContext["mcpReq"]["notify"];
  log(
    level: "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency",
    data: unknown,
    logger?: string,
  ): Promise<void>;
  reportProgress(progress: number, total?: number, message?: string): Promise<void>;
}

export interface McpToolInvocation {
  readonly tool: string;
  readonly input: unknown;
  readonly context: McpToolContext;
}

export type McpToolNext = () => Promise<unknown>;
export type McpToolMiddleware = (
  invocation: McpToolInvocation,
  next: McpToolNext,
) => MaybePromise<unknown>;

export interface McpApplicationBase {
  readonly middleware?: readonly McpToolMiddleware[];
  readonly createContext?: (context: McpToolContext) => MaybePromise<McpToolContext>;
  readonly onUnhandledError?: (
    error: unknown,
    context: McpToolContext,
    tool: string,
  ) => MaybePromise<void>;
  readonly http?: McpHttpServerOptions;
  readonly stdio?: McpStdioOptions;
}

export interface NativeMcpApplication<Handlers> extends McpApplicationBase {
  readonly kind?: "native";
  readonly handlers: Handlers;
}

export interface HttpBridgeMcpApplication<Handlers> extends McpApplicationBase {
  readonly kind: "http-bridge";
  readonly bridge: McpHttpBridgeOptions;
  readonly handlers?: Partial<Handlers>;
}

export interface HybridMcpApplication<Handlers> extends McpApplicationBase {
  readonly kind: "hybrid";
  readonly handlers: Handlers;
  readonly bridge: McpHttpBridgeOptions;
  readonly execution?: "native" | "http-bridge";
}

export type McpApplication<Handlers> =
  | NativeMcpApplication<Handlers>
  | HttpBridgeMcpApplication<Handlers>
  | HybridMcpApplication<Handlers>;

export function defineMcpApplication<T extends McpApplication<unknown>>(application: T): T {
  return application;
}
