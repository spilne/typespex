import type { DiagnosticTarget } from "@typespec/compiler";
import type { ValueCodecDocument } from "@typespex/codec";

export const COMPILER_PLAN_VERSION = 1 as const;

export type JsonSchema = boolean | Readonly<Record<string, unknown>>;

export interface ServicePlan {
  readonly version: typeof COMPILER_PLAN_VERSION;
  readonly name: string;
  readonly namespace: string;
  readonly types: readonly TypePlan[];
  readonly operations: readonly OperationPlan[];
}

export interface OperationPlan {
  readonly version: typeof COMPILER_PLAN_VERSION;
  readonly name: string;
  readonly input: JsonWirePlan;
  readonly success?: JsonWirePlan;
  readonly errors?: JsonWirePlan;
}

export interface TypePlan {
  readonly version: typeof COMPILER_PLAN_VERSION;
  readonly key: string;
  readonly name?: string;
  readonly semanticType: string;
  readonly wireType: string;
}

export interface JsonWirePlan {
  readonly version: typeof COMPILER_PLAN_VERSION;
  readonly schema: JsonSchema;
  /** Omitted when the validated JSON value is already the semantic value. */
  readonly codec?: ValueCodecDocument;
  readonly semanticType: string;
  readonly wireType: string;
}

export interface ArtifactPlan {
  readonly version: typeof COMPILER_PLAN_VERSION;
  readonly artifact: string;
  readonly fileName: string;
  readonly outputDir: string;
  readonly content: string;
}

export interface CompilerIssue {
  readonly code:
    | "unsafe-number"
    | "unsupported-encoding"
    | "unsupported-stream"
    | "unsupported-type";
  readonly message: string;
  readonly target: DiagnosticTarget;
}
