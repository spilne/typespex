import type { Namespace, Operation } from "@typespec/compiler";

export interface McpIconOptions {
  readonly src: string;
  readonly mimeType?: string;
  readonly sizes?: readonly string[];
}

export interface McpToolAnnotationsOptions {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface McpServerOptions {
  readonly name?: string;
  readonly version: string;
  readonly instructions?: string;
  readonly icons?: readonly McpIconOptions[];
  readonly websiteUrl?: string;
}

export interface McpToolOptions {
  readonly name?: string;
  readonly title?: string;
  readonly icons?: readonly McpIconOptions[];
  readonly annotations?: McpToolAnnotationsOptions;
}

export interface McpServerMetadata extends McpServerOptions {
  readonly namespace: Namespace;
}

export interface McpToolMetadata extends McpToolOptions {
  readonly operation: Operation;
}
