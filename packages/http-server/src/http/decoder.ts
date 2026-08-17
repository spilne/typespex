// Stable public decoder surface; implementation modules remain package-internal.
import { multipartDecoders } from "./multipart-decoder.js";
import { valueDecoders } from "./value-decoder.js";

export {
  Decoder,
  decode,
  decodeOptional,
  decodeOptionalOrThrow,
  decodeOrThrow,
  decodeRequired,
  decodeRequiredOrThrow,
  fail,
  optional,
  prefixIssues,
  succeed,
  toValidationResult,
  traverseEither,
  type DecoderResult,
  type DiscriminatedDecoderOptions,
  type FileDecoderOptions,
  type ObjectDecoderOptions,
} from "./value-decoder.js";
export type {
  MultipartFormDataDescriptor,
  MultipartPartDecoderMap,
  MultipartPartDescriptor,
  MultipartPartKind,
  MultipartTupleDescriptors,
} from "./multipart-decoder.js";
export {
  decodeBody,
  decodeFormBody,
  decodeJsonBody,
  decodeJsonBodyOrThrow,
  decodeJsonlBody,
  decodeMultipartBody,
  type BodyDecodeError,
  type BodyDecodeOptions,
  type BodyDecoderMap,
  type BodyMediaKind,
  type JsonlBodyDecodeOptions,
} from "./body-decoder.js";

/** Value decoders for HTTP parameters and request bodies. */
export const Decoders = {
  ...valueDecoders,
  ...multipartDecoders,
} as const;
