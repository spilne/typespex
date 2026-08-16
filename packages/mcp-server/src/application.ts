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
}

export interface NativeMcpApplication<Handlers> extends McpApplicationBase {
  readonly kind?: "native";
  readonly handlers: Handlers;
}

export type McpApplication<Handlers> = NativeMcpApplication<Handlers>;

export function defineMcpApplication<T extends McpApplication<any>>(application: T): T {
  return application;
}
