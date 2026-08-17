import type { Model, Namespace, Program, Type, VisibilityProvider } from "@typespec/compiler";
import type { HttpOperation, HttpOperationResponseContent, HttpServer } from "@typespec/http";
import type { StreamMetadata } from "@typespec/http/experimental";

export interface HttpPlanningApi {
  readonly getServers: (program: Program, type: Namespace) => HttpServer[] | undefined;
  readonly getStreamMetadata: (
    program: Program,
    source: HttpOperation["parameters"] | HttpOperationResponseContent,
  ) => StreamMetadata | undefined;
  readonly HttpVisibilityProvider: (verb: HttpOperation["verb"]) => VisibilityProvider;
}

export interface BridgeStreamAnalysis {
  readonly elementTypes: ReadonlyMap<Model, Type>;
  readonly typeSubstitutions: ReadonlyMap<Model, Type>;
  readonly issues: readonly {
    readonly operation: HttpOperation;
    readonly message: string;
  }[];
}
