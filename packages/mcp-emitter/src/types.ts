import type { Namespace, Operation } from "@typespec/compiler";
import type { HttpService } from "@typespec/http";
import type { OperationPlan, ServicePlan, TypePlanner } from "@typespex/compiler-core/unstable";
import type { HttpWireOperationPlan } from "@typespex/http-client";
import type { McpServerMetadata, McpToolMetadata } from "@typespex/mcp";
import type { HttpPlanningApi } from "./http-planner.js";

export interface ResolvedModes {
  readonly native: boolean;
  readonly httpBridge: boolean;
}

export interface PlannedServer {
  readonly plan: ServicePlan;
  readonly metadata: McpServerMetadata;
  readonly name: string;
  readonly symbolName: string;
  readonly outputDir: string;
  readonly fileNames: OutputFileNames;
  readonly planner: TypePlanner;
  readonly tools: readonly PlannedTool[];
  readonly applicationModule?: string;
  readonly modes: ResolvedModes;
}

export interface PlannedTool {
  readonly plan: OperationPlan;
  readonly metadata: McpToolMetadata;
  readonly operation: Operation;
  readonly name: string;
  readonly symbolName: string;
  readonly allowsVoid: boolean;
  readonly annotations?: McpToolMetadata["annotations"];
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
