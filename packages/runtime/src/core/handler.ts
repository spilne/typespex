import type { BaseRequestContext } from "./context.js";
import type { Either } from "./either.js";

/**
 * Business handler for one generated operation.
 * Receives decoded input plus request context and returns a typed success or failure.
 * Right = success, Left = declared error.
 */
export type OperationHandler<I, E, O, Ctx = BaseRequestContext> = (
  input: I,
  ctx: Ctx,
) => Promise<Either<E, O>>;
