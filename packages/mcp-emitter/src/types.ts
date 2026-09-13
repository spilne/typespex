import type { Namespace } from "@typespec/compiler";
import type { HttpService } from "@typespec/http";
import type {
  OperationPlan,
  ServicePlan,
  TypeScriptModulePlan,
} from "@typespex/compiler-core/unstable";
import type { HttpWireOperationPlan } from "@typespex/http-client";
import type { McpIconOptions, McpToolAnnotationsOptions } from "@typespex/mcp";
import type { HttpPlanningApi } from "./http-planner.js";

export interface ResolvedModes {
  readonly native: boolean;
  readonly httpBridge: boolean;
}

export interface PlannedServer {
  readonly plan: ServicePlan;
  readonly modelModule: TypeScriptModulePlan;
  readonly symbolName: string;
  readonly outputDir: string;
  readonly fileNames: OutputFileNames;
  readonly tools: readonly PlannedTool[];
  readonly version: string;
  readonly instructions?: string;
  readonly icons?: readonly McpIconOptions[];
  readonly websiteUrl?: string;
  readonly applicationModule?: string;
  readonly modes: ResolvedModes;
}

export interface PlannedTool {
  readonly plan: OperationPlan;
  readonly name: string;
  readonly symbolName: string;
  readonly title?: string;
  readonly description?: string;
  readonly icons?: readonly McpIconOptions[];
  readonly allowsVoid: boolean;
  readonly annotations?: McpToolAnnotationsOptions;
  readonly http?: HttpWireOperationPlan;
  readonly requiresTaggedResult: boolean;
}

export interface BridgePlanningContext {
  readonly services: ReadonlyMap<Namespace, HttpService>;
  readonly api: HttpPlanningApi;
}

export interface OutputFileNames {
  readonly models: string;
  readonly operations: string;
  readonly server: string;
  readonly httpBridge: string;
  readonly stdio: string;
  readonly node: string;
  readonly bun: string;
  readonly express: string;
  readonly hono: string;
}
