import type { Type } from "@typespec/compiler";
import type { HttpOperation, HttpOperationParameter } from "@typespec/http";
import { getStreamMetadata, type StreamMetadata } from "@typespec/http/experimental";
import { normalizeMediaType } from "./body-media-kinds.js";
import type { EmitterCtx } from "./ctx.js";
import { propertiesShareSource } from "./http-models.js";

export interface RequestStreamAnalysis {
  readonly metadata: StreamMetadata;
  readonly unsupportedReason?: string;
}

/** Resolves a typed request stream and the protocol limitation, if any. */
export function analyzeRequestStream(
  ctx: EmitterCtx,
  operation: HttpOperation,
): RequestStreamAnalysis | undefined {
  const metadata = getStreamMetadata(ctx.program, operation.parameters);
  if (!metadata) return undefined;

  const body = operation.parameters.body;
  if (body?.bodyKind !== "single") {
    return { metadata, unsupportedReason: "JSONL streams require a single HTTP body" };
  }

  const mediaTypes = metadata.contentTypes.map(normalizeMediaType);
  if (
    mediaTypes.length === 0 ||
    mediaTypes.some((mediaType) => mediaType !== "application/jsonl")
  ) {
    return {
      metadata,
      unsupportedReason:
        "typed streams require a dedicated streaming decoder for this content type",
    };
  }

  if (requestStreamBodyIsOptional(operation)) {
    return { metadata, unsupportedReason: "JSONL request streams require a body" };
  }

  return { metadata };
}

/** Returns metadata only for the request-stream protocol emitted by this package. */
export function getJsonlRequestStream(
  ctx: EmitterCtx,
  operation: HttpOperation,
): StreamMetadata | undefined {
  const analysis = analyzeRequestStream(ctx, operation);
  return analysis?.unsupportedReason === undefined ? analysis?.metadata : undefined;
}

/**
 * Request parameters exposed to handlers for a supported JSONL stream.
 * The stream model's fixed Content-Type property is wire metadata, not an
 * independent handler value.
 */
export function getHandlerRequestParameters(
  ctx: EmitterCtx,
  operation: HttpOperation,
): readonly HttpOperationParameter[] {
  if (!getJsonlRequestStream(ctx, operation)) return operation.parameters.parameters;

  const contentTypeProperty = operation.parameters.body?.contentTypeProperty;
  if (!contentTypeProperty) return operation.parameters.parameters;
  return operation.parameters.parameters.filter(
    (parameter) => !propertiesShareSource(parameter.param, contentTypeProperty),
  );
}

function requestStreamBodyIsOptional(operation: HttpOperation): boolean {
  const bodyProperty = operation.parameters.body?.property;
  if (!bodyProperty) return false;
  if (bodyProperty.optional) return true;

  const resolvedBody = operation.parameters.properties.find(
    (property) =>
      property.kind === "body" && propertiesShareSource(property.property, bodyProperty),
  );
  if (!resolvedBody) return false;

  let current: Type = operation.operation.parameters;
  for (const segment of resolvedBody.path) {
    if (typeof segment !== "string" || current.kind !== "Model") return false;
    const property = current.properties.get(segment);
    if (!property) return false;
    if (property.optional) return true;
    current = property.type;
  }
  return false;
}
