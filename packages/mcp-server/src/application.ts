import type { ServerContext } from "@modelcontextprotocol/server";

export type MaybePromise<T> = T | Promise<T>;

export interface McpToolContext {
  readonly requestId: string | number;
  readonly requestMeta?: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  readonly authInfo?: McpInboundAuthInfo;
  /** Advanced SDK escape hatch. Prefer the stable TypeSpex fields above. */
  readonly raw: ServerContext;
  readonly notify: (notification: McpNotification) => Promise<void>;
  log(
    level: "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency",
    data: unknown,
    logger?: string,
  ): Promise<void>;
  reportProgress(progress: number, total?: number, message?: string): Promise<void>;
}

export interface McpInboundAuthInfo {
  readonly token: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly expiresAt?: number;
  readonly resource?: URL;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface McpNotification {
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface McpToolInvocation<Context extends McpToolContext = McpToolContext> {
  readonly tool: string;
  readonly input: unknown;
  readonly context: Context;
}

export type McpToolNext = () => Promise<unknown>;
export type McpToolMiddleware<Context extends McpToolContext = McpToolContext> = (
  invocation: McpToolInvocation<Context>,
  next: McpToolNext,
) => MaybePromise<unknown>;

export interface McpApplicationBase<Context extends McpToolContext = McpToolContext> {
  readonly middleware?: readonly McpToolMiddleware<Context>[];
  readonly createContext?: (context: McpToolContext) => MaybePromise<Context>;
  readonly onUnhandledError?: (
    error: unknown,
    context: Context,
    tool: string,
  ) => MaybePromise<void>;
}

export interface NativeMcpApplication<
  Handlers,
  Context extends McpToolContext = McpToolContext,
> extends McpApplicationBase<Context> {
  readonly kind?: "native";
  readonly handlers: Handlers;
}

export type McpApplication<
  Handlers,
  Context extends McpToolContext = McpToolContext,
> = NativeMcpApplication<Handlers, Context>;

export function defineMcpApplication<T extends McpApplication<any, any>>(application: T): T {
  return application;
}
