import {
  HTTP_OPERATION_PLAN_VERSION,
  type HttpAuthAlternativePlan,
  type HttpAuthSchemePlan,
  type HttpWireValuePlan,
} from "@typespex/http-client";
import type { McpApplicationBase, McpToolContext, MaybePromise } from "@typespex/mcp-server";

export const HTTP_BRIDGE_OPERATION_VERSION = HTTP_OPERATION_PLAN_VERSION;

export type HttpParameterLocation = "path" | "query" | "header" | "cookie";
export type HttpParameterStyle =
  | "simple"
  | "label"
  | "matrix"
  | "path"
  | "form"
  | "spaceDelimited"
  | "pipeDelimited"
  | "deepObject";

export interface HttpBridgeParameter {
  readonly source: readonly (string | number)[];
  readonly name: string;
  readonly location: HttpParameterLocation;
  readonly required?: boolean;
  readonly style?: HttpParameterStyle;
  readonly explode?: boolean;
  readonly allowReserved?: boolean;
  readonly value?: HttpWireValuePlan;
}

export interface HttpBridgeBody {
  readonly source?: readonly (string | number)[];
  readonly fields?: readonly {
    readonly source: readonly (string | number)[];
    readonly target: readonly (string | number)[];
  }[];
  readonly kind: "json" | "form" | "multipart" | "text" | "binary" | "file" | "jsonl";
  readonly contentType?: string;
  readonly contentTypeSource?: readonly (string | number)[];
  readonly mediaTypes?: readonly {
    readonly contentType: string;
    readonly kind: HttpBridgeBody["kind"];
    readonly value?: HttpWireValuePlan;
  }[];
  readonly multipartParts?: readonly HttpBridgeMultipartPart[];
  readonly value?: HttpWireValuePlan;
}

export interface HttpBridgeMultipartPart {
  readonly source: readonly (string | number)[];
  readonly name?: string;
  readonly multi: boolean;
  readonly optional: boolean;
  readonly kind: "json" | "text" | "binary" | "file";
  readonly contentTypes: readonly string[];
  readonly value?: HttpWireValuePlan;
}

export interface HttpBridgeResponseHeader {
  readonly name: string;
  readonly target: string | readonly (string | number)[];
  readonly collection?: boolean;
  readonly value?: HttpWireValuePlan;
}

export interface HttpBridgeResponse {
  readonly statuses: readonly (number | `${number}XX` | "default")[];
  readonly mediaTypes?: readonly string[];
  readonly kind?: "json" | "form" | "multipart" | "text" | "binary" | "file" | "jsonl" | "empty";
  readonly error?: boolean;
  readonly bodyValue?: HttpWireValuePlan;
  readonly multipartParts?: readonly HttpBridgeResponseMultipartPart[];
  readonly bodyTarget?: string | readonly (string | number)[];
  readonly statusTarget?: string | readonly (string | number)[];
  readonly contentTypeTarget?: string | readonly (string | number)[];
  readonly headers?: readonly HttpBridgeResponseHeader[];
}

export interface HttpBridgeResponseMultipartPart {
  readonly target: readonly (string | number)[];
  readonly name?: string;
  readonly multi: boolean;
  readonly optional: boolean;
  readonly kind: "json" | "text" | "binary" | "file";
  readonly contentTypes: readonly string[];
  readonly value?: HttpWireValuePlan;
}

export type { HttpWireValuePlan } from "@typespex/http-client";
export type HttpAuthScheme = HttpAuthSchemePlan;
export type HttpAuthAlternative = HttpAuthAlternativePlan;

export interface HttpBridgeServer {
  readonly url: string;
  readonly fullyDefaulted?: boolean;
}

export interface HttpBridgeOperation {
  readonly version: typeof HTTP_BRIDGE_OPERATION_VERSION;
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly literalQuery?: readonly { readonly name: string; readonly value: string }[];
  readonly parameters?: readonly HttpBridgeParameter[];
  readonly body?: HttpBridgeBody;
  readonly responses: readonly HttpBridgeResponse[];
  readonly servers?: readonly HttpBridgeServer[];
  readonly auth?: readonly HttpAuthAlternative[];
}

export interface HttpAuthCredentials {
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly cookies?: Readonly<Record<string, string>>;
}

export interface HttpAuthProviderRequest {
  readonly operation: HttpBridgeOperation;
  readonly alternatives: readonly HttpAuthAlternative[];
  readonly input: unknown;
  readonly context: McpToolContext;
}

export type McpHttpAuthProvider = (
  request: HttpAuthProviderRequest,
) => MaybePromise<HttpAuthCredentials | undefined>;

export interface HttpServerResolverRequest {
  readonly operation: HttpBridgeOperation;
  readonly input: unknown;
  readonly context: McpToolContext;
}

export interface McpHttpBridgeOptions {
  readonly server?: string | URL;
  readonly resolveServer?: (
    request: HttpServerResolverRequest,
  ) => MaybePromise<string | URL | undefined>;
  readonly authProvider?: McpHttpAuthProvider;
  readonly fetch?: typeof globalThis.fetch;
  /** Origins to which an operation may resolve or redirect. */
  readonly allowedUpstreamOrigins?: readonly string[];
  /** Redirect count. Zero disables redirects. Defaults to 3. */
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
  readonly maxJsonlItems?: number;
  readonly maxResponseBytes?: number;
  readonly maxDiagnosticBytes?: number;
  /** Explicitly exposes bounded upstream diagnostic bodies in MCP operational errors. */
  readonly exposeUpstreamDiagnostics?: boolean;
}

export interface McpHttpBridgeApplication extends McpApplicationBase {
  readonly kind: "http-bridge";
  readonly bridge: McpHttpBridgeOptions;
}

export interface HttpBridgeResult {
  readonly kind: "success" | "error";
  readonly value: unknown;
  readonly status: number;
}
