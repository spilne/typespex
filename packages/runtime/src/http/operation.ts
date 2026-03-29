import type { Either } from "../core/either.js";
import type { ValidationError } from "./codec.js";
import type { EndpointMeta } from "./metadata.js";

/** Decode result: synchronous Either or async Promise of Either. */
export type DecodeResult<I> = Either<ValidationError, I> | Promise<Either<ValidationError, I>>;

/** Generated HTTP operation with decode and encode functions for server execution. */
export interface ServerOperation<I, E, O> {
  readonly endpoint: EndpointMeta;
  decodeInput(
    request: Request,
    pathParams: Readonly<Record<string, string>>,
  ): DecodeResult<I>;
  encodeOutput(output: O): Response;
  encodeError(error: E): Response;
}
