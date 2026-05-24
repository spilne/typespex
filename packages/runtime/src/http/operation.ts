import type { Either } from "../core/either.js";
import type { UnsupportedMediaTypeError, ValidationError } from "./validation.js";
import type { EndpointMeta } from "./metadata.js";

/** Errors a server operation's decoder may surface at the boundary. */
export type DecodeError = ValidationError | UnsupportedMediaTypeError;

/** Decode result: synchronous Either or async Promise of Either. */
export type DecodeResult<I> = Either<DecodeError, I> | Promise<Either<DecodeError, I>>;

/** Generated HTTP operation with decode and encode functions for server execution. */
export interface ServerOperation<I, R> {
  readonly endpoint: EndpointMeta;
  decodeInput(
    request: Request,
    pathParams: Readonly<Record<string, string>>,
  ): DecodeResult<I>;
  encodeResult(result: R): Response;
}
