import type { BaseRequestContext } from "../core/context.js";
import type { MatchedEndpoint } from "./metadata.js";

/** HTTP-aware request context exposed to middleware and custom router hooks. */
export interface RequestContext extends BaseRequestContext {
  readonly match?: MatchedEndpoint;
}

/** Request context for matched operations after routing has succeeded. */
export interface MatchedRequestContext extends RequestContext {
  readonly match: MatchedEndpoint;
}
