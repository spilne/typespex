import type { Hints } from "../core/hints.js";

/** HTTP methods supported by the generated server runtime. */
export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD";

/** Runtime metadata for the generated TypeSpec service. */
export interface ServiceMeta {
  readonly name: string;
  readonly hints: Hints;
}

/** Runtime metadata for one namespace in the operation's namespace chain. */
export interface NamespaceMeta {
  readonly name: string;
  readonly fullName: string;
  readonly hints: Hints;
}

/** Operation-level HTTP metadata used by routing, logging, and middleware. */
export interface OperationMeta {
  readonly name: string;
  readonly operationId: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly hints: Hints;
}

/** Static metadata for a generated server operation. */
export interface EndpointMeta {
  readonly service: ServiceMeta;
  readonly namespaces: readonly NamespaceMeta[];
  readonly operation: OperationMeta;
}

/** Matched endpoint — composition of static metadata + request-specific path params. */
export interface MatchedEndpoint {
  readonly endpoint: EndpointMeta;
  readonly pathParams: Readonly<Record<string, string>>;
}
