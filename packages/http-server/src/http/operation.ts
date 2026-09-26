import type { Either } from "../core/either.js";
import type { RequestBodyTooLargeError } from "./body-limit.js";
import type { UnsupportedMediaTypeError, ValidationError } from "./validation.js";
import type { EndpointMeta } from "./metadata.js";

/** Errors a server operation's decoder may surface at the boundary. */
export type DecodeError = ValidationError | UnsupportedMediaTypeError | RequestBodyTooLargeError;

/** Decode result: synchronous Either or async Promise of Either. */
export type DecodeResult<I> = Either<DecodeError, I> | Promise<Either<DecodeError, I>>;

/** Generated HTTP operation with decode and encode functions for server execution. */
export interface ServerOperation<I, R> {
  readonly endpoint: EndpointMeta;
  decodeInput(request: Request, pathParams: Readonly<Record<string, string>>): DecodeResult<I>;
  /**
   * Optional generated entry point for operations with only scalar path inputs.
   * The transport must verify routing and percent-decoding before using it.
   * Raw captures remain available through the handler's request context.
   * @internal
   */
  decodeNativePathInput?(pathParams: Readonly<Record<string, string>>): DecodeResult<I>;
  /**
   * Optional generated entry point that decodes the input and finishes the
   * request inside the body decoder's own asynchronous frame, so a request
   * with a body settles one promise instead of two. The router supplies
   * `finish`, which never throws.
   * @internal
   */
  decodeInputThen?(
    request: Request,
    pathParams: Readonly<Record<string, string>>,
    finish: (result: Either<DecodeError, I>) => Response | Promise<Response>,
  ): Promise<Response>;
  encodeResult(result: R): Response;
}
