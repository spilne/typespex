import type { BaseRequestContext } from "./context.js";

/**
 * Business handler for one generated operation.
 * Receives decoded input plus request context and returns one modeled HTTP result.
 */
export type OperationHandler<I, R, Ctx = BaseRequestContext> = (
  input: I,
  ctx: Ctx,
) => R | Promise<R>;
