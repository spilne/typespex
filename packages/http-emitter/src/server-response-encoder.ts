/**
 * Emits response encoder expressions from planned HTTP response variants.
 */
import type { HttpOperation } from "@typespec/http";
import {
  isJsonMediaType,
  isTextMediaType,
  isXmlMediaType,
  normalizeMediaType,
} from "./body-media-kinds.js";
import type { EmitterCtx } from "./ctx.js";
import {
  emitJsonWireSerializer,
  unsupportedJsonWireTransformReason,
} from "./json-wire-transforms.js";
import { $lib } from "./lib.js";
import { payloadTypeToTs } from "./payload-context.js";
import { resolveScalarEncoding } from "./scalar-encoding.js";
import { buildResponseBranches, type ResponseBranch } from "./server-response-dispatch.js";
import {
  collectResponseVariants,
  type ResponseHeader,
  type ResponseVariant,
} from "./server-response-plan.js";
import { buildSseResponsePlan } from "./sse-response.js";
import { tsLiteral, tsPropertyAccess } from "./typescript-names.js";
import { isBytesScalar, isTextResponseType, unsupportedFileContentsReason } from "./wire-types.js";
import { unsupportedXmlTypeReason } from "./xml-metadata.js";
import { emitXmlCodec } from "./xml-wire-codecs.js";

/** Response encoder expression used in generated result encoder objects. */
export function emitResultResponseEncoder(
  ctx: EmitterCtx,
  op: HttpOperation,
  resultType: string,
): string {
  const responses = collectResponseVariants(ctx, op);
  const streamResponses = responses.filter((response) => response.streamType !== undefined);
  if (streamResponses.length > 0 && responses.length > 1) {
    for (const response of streamResponses) {
      reportUnsupportedResponseBody(
        ctx,
        op,
        response,
        "typed stream responses cannot be combined with other response variants",
      );
    }
    return emitUnsupportedEncoderReason(
      resultType,
      `Operation "${op.operation.name}" combines a typed stream with other response variants. ` +
        `@typespex/http-emitter cannot serialize this; regenerate after addressing the diagnostic.`,
    );
  }
  if (responses.length > 1) {
    const branches = buildResponseBranches(ctx, op, responses);
    if (branches.length > 0) {
      return emitResponseDecisionEncoder(ctx, op, resultType, branches);
    }
    $lib.reportDiagnostic(ctx.program, {
      code: "undifferentiable-response-union",
      target: op.operation,
    });
    // Don't silently fall back to responses[0] — that would ship a server
    // that handles only the first declared variant. Emit a placeholder that
    // throws if anyone bypasses the diagnostic, matching the unsupported-CT
    // pattern from PR #26.
    return emitUnsupportedEncoderReason(
      resultType,
      `Operation "${op.operation.name}" declares ${responses.length} response variants the emitter cannot ` +
        `distinguish at the result-value level. @typespex/http-emitter cannot serialize this; regenerate after ` +
        `addressing the diagnostic.`,
    );
  }

  const response = responses[0];
  if (!response) {
    return "ResponseEncoders.empty(204)";
  }
  if (response.isVoid) {
    return `ResponseEncoders.empty(${response.statusCode})`;
  }

  const kind = classifyResponseVariant(ctx, op, response);
  if (kind === "unsupported") {
    return emitUnsupportedEncoder(resultType, op.operation.name, response.contentType);
  }
  const bodyTransform = getResponseBodyTransform(ctx, op, response, kind);

  if (kind === "sse") {
    const result = buildSseResponsePlan(ctx, response.streamType!, response.projection);
    if (!result.supported) {
      reportUnsupportedResponseBody(ctx, op, response, result.reason);
      return emitUnsupportedEncoderReason(
        resultType,
        `Operation "${op.operation.name}" declares an SSE response the emitter cannot serialize. ` +
          `Regenerate after addressing the diagnostic.`,
      );
    }
    return `ResponseEncoders.sse<${result.plan.itemType}>(${response.statusCode}, ${result.plan.transform})`;
  }

  if (kind === "jsonl") {
    return encoderForKind(
      kind,
      resultType,
      response.statusCode,
      response.contentType,
      bodyTransform,
      responseStreamItemTypeToTs(ctx, response),
    );
  }

  if (shouldUseVariantEncoder(response)) {
    return `ResponseEncoders.variant<${resultType}>(${emitResponseVariant(kind, response, bodyTransform)})`;
  }

  const headers = response.headers;
  const encoder = encoderForKind(
    kind,
    resultType,
    response.statusCode,
    response.contentType,
    bodyTransform,
  );

  if (headers.length > 0 && kind === "json") {
    const entries = headers.map(emitResponseHeaderEntry).join(", ");
    const transform = bodyTransform
      ? `, (body) => ${emitResponseBodyTransform("body", bodyTransform)}`
      : "";
    return `ResponseEncoders.jsonWithHeaders<${resultType}>(${response.statusCode}, [${entries}]${transform})`;
  }

  return encoder;
}

function shouldUseVariantEncoder(response: ResponseVariant): boolean {
  return (
    !response.hasBody ||
    response.body?.bodyKind === "file" ||
    response.dynamicStatus !== undefined ||
    response.bodyProperty !== undefined ||
    response.omitProperties.length > 0
  );
}

interface ResponseBodyTransform {
  readonly serializer: string;
  readonly bodyType: string;
  readonly optional: boolean;
  readonly path: string;
}

function getResponseBodyTransform(
  ctx: EmitterCtx,
  op: HttpOperation,
  response: ResponseVariant,
  kind: Exclude<ResponseEncoderKind, "unsupported">,
): ResponseBodyTransform | undefined {
  if (kind === "xml") {
    const body = response.body;
    if (!body || body.bodyKind !== "single") return undefined;
    const serializationType = response.serializationType ?? body.type;
    return {
      serializer: emitXmlCodec(ctx, serializationType, response.projection, body.property),
      bodyType: payloadTypeToTs(ctx, serializationType, response.projection),
      optional: body.property?.optional === true,
      path: response.bodyProperty
        ? tsPropertyAccess("$response", response.bodyProperty)
        : "$response",
    };
  }
  if (kind !== "json" && kind !== "jsonl" && kind !== "text") return undefined;
  return getResponseWireTransform(ctx, op, response, kind === "text" ? "text" : "value");
}

function getResponseWireTransform(
  ctx: EmitterCtx,
  op: HttpOperation,
  response: ResponseVariant,
  encodingContext: "value" | "text",
): ResponseBodyTransform | undefined {
  const body = response.body;
  const serializationType = response.serializationType;
  if (!body || body.bodyKind !== "single" || !serializationType) return undefined;
  const target = response.streamType ? undefined : body.property;

  const reason = unsupportedJsonWireTransformReason(
    ctx,
    serializationType,
    response.projection,
    new Set(),
    target,
  );
  if (reason) {
    if (encodingContext === "text") {
      reportUnsupportedResponseBody(ctx, op, response, reason);
    } else {
      $lib.reportDiagnostic(ctx.program, {
        code: "unsupported-json-serialization",
        format: { operation: op.operation.name, reason },
        target: body.property ?? op.operation,
      });
    }
    return undefined;
  }

  const serializer = emitJsonWireSerializer(
    ctx,
    serializationType,
    response.projection,
    target,
    encodingContext,
  );
  if (!serializer) return undefined;
  return {
    serializer,
    bodyType: payloadTypeToTs(ctx, serializationType, response.projection),
    optional: response.streamType ? false : body.property?.optional === true,
    path: response.streamType
      ? "$response[]"
      : response.bodyProperty
        ? tsPropertyAccess("$response", response.bodyProperty)
        : "$response",
  };
}

function emitResponseBodyTransform(value: string, transform: ResponseBodyTransform): string {
  const serialized = `${transform.serializer}.serialize(${value} as ${transform.bodyType}, ${tsLiteral(transform.path)})`;
  return transform.optional ? `${value} === undefined ? undefined : ${serialized}` : serialized;
}

function emitResponseHeaderEntry(header: ResponseHeader): string {
  const fields = [tsLiteral(header.property), tsLiteral(header.header)];
  if (header.explode || header.transform) fields.push(String(header.explode));
  if (header.transform) fields.push(header.transform);
  return `[${fields.join(", ")}]`;
}

function emitResponseDecisionEncoder(
  ctx: EmitterCtx,
  op: HttpOperation,
  resultType: string,
  branches: readonly ResponseBranch[],
): string {
  const lines: string[] = [];
  lines.push(`ResponseEncoders.matchVariant<${resultType}>([`);
  branches.forEach((branch) => {
    const kind = branch.response.isVoid
      ? "empty"
      : classifyResponseVariant(ctx, op, branch.response);
    if (kind === "jsonl" || kind === "sse") {
      throw new Error(
        "stream response variants must be rejected before response dispatch emission",
      );
    }
    const branchEncoder =
      kind === "unsupported"
        ? emitUnsupportedEncoder(
            branch.response.tsType,
            op.operation.name,
            branch.response.contentType,
          )
        : `ResponseEncoders.variant<${branch.response.tsType}>(${emitResponseVariant(
            kind,
            branch.response,
            getResponseBodyTransform(ctx, op, branch.response, kind),
          )})`;
    lines.push("{");
    lines.push(`when: (result): result is ${branch.response.tsType} => ${branch.condition},`);
    lines.push(`encoder: ${branchEncoder},`);
    lines.push("},");
  });
  // TODO: Benchmark matchVariant against generated direct if/switch dispatch for hot response paths.
  lines.push("])");
  return lines.join("\n");
}

function emitResponseVariant(
  kind: Exclude<ResponseEncoderKind, "unsupported" | "jsonl" | "sse">,
  response: ResponseVariant,
  bodyTransform?: ResponseBodyTransform,
): string {
  const fields = [`status: ${emitResponseStatus(response)}`];
  if (kind !== "json") fields.push(`kind: ${tsLiteral(kind)}`);
  if (response.contentType) fields.push(`contentType: ${tsLiteral(response.contentType)}`);
  if (response.fileContentTypes.length > 0) {
    fields.push(`contentTypes: ${tsLiteral(response.fileContentTypes)}`);
  }
  if (response.fileContentTypeRequired) fields.push("requireFileContentType: true");
  if (response.fileNameRequired) fields.push("requireFileName: true");
  if (!response.emitFileContentDisposition) fields.push("emitFileContentDisposition: false");
  if (response.bodyProperty) fields.push(`body: ${tsLiteral(response.bodyProperty)}`);
  if (response.headers.length > 0) {
    const headers = response.headers.map(emitResponseHeaderEntry).join(", ");
    fields.push(`headers: [${headers}]`);
  }
  if (response.omitProperties.length > 0) {
    fields.push(`omit: [${response.omitProperties.map((name) => tsLiteral(name)).join(", ")}]`);
  }
  if (bodyTransform) {
    fields.push(`transformBody: (body) => ${emitResponseBodyTransform("body", bodyTransform)}`);
  }
  return `{ ${fields.join(", ")} }`;
}

function emitResponseStatus(response: ResponseVariant): string {
  if (!response.dynamicStatus) return String(response.statusCode);
  const allowed = response.dynamicStatus.allowed
    .map((status) =>
      typeof status === "number"
        ? String(status)
        : `{ start: ${status.start}, end: ${status.end} }`,
    )
    .join(", ");
  return `{ property: ${tsLiteral(response.dynamicStatus.property.name)}, allowed: [${allowed}] }`;
}

type ResponseEncoderKind =
  | "json"
  | "jsonl"
  | "sse"
  | "xml"
  | "text"
  | "bytes"
  | "file"
  | "empty"
  | "unsupported";

function classifyResponseVariant(
  ctx: EmitterCtx,
  op: HttpOperation,
  response: ResponseVariant,
): ResponseEncoderKind {
  if (!response.hasBody) return "empty";

  if (response.streamType) {
    const contentType = response.contentType ? normalizeMediaType(response.contentType) : undefined;
    if (contentType !== "application/jsonl" && contentType !== "text/event-stream") {
      reportUnsupportedResponseBody(
        ctx,
        op,
        response,
        "typed streams require a dedicated streaming encoder for this content type",
      );
      return "unsupported";
    }
    if (response.body?.bodyKind !== "single") {
      reportUnsupportedResponseBody(ctx, op, response, "typed streams require a single HTTP body");
      return "unsupported";
    }
    if (
      response.dynamicStatus ||
      response.headers.length > 0 ||
      response.body.property?.optional === true
    ) {
      reportUnsupportedResponseBody(
        ctx,
        op,
        response,
        "typed response stream envelopes with dynamic status, headers, or an optional body require a dedicated encoder",
      );
      return "unsupported";
    }
    return contentType === "application/jsonl" ? "jsonl" : "sse";
  }

  const body = response.body;
  if (body?.bodyKind === "file") {
    const reason = unsupportedFileContentsReason(ctx.program, body);
    if (!reason) return "file";
    reportUnsupportedResponseBody(ctx, op, response, reason);
    return "unsupported";
  }
  if (body && body.bodyKind !== "single") {
    reportUnsupportedResponseBody(
      ctx,
      op,
      response,
      `${body.bodyKind} bodies require a dedicated response encoder`,
    );
    return "unsupported";
  }

  const kind = classifyResponseContentType(ctx, op, response);
  if (kind === "unsupported") return kind;

  const reason = incompatibleResponseBodyReason(ctx, response, kind);
  if (!reason) return kind;

  reportUnsupportedResponseBody(ctx, op, response, reason);
  return "unsupported";
}

function reportUnsupportedResponseBody(
  ctx: EmitterCtx,
  op: HttpOperation,
  response: ResponseVariant,
  reason: string,
): void {
  $lib.reportDiagnostic(ctx.program, {
    code: "unsupported-response-body",
    format: {
      contentType:
        response.body?.bodyKind === "file"
          ? response.fileContentTypes.join(", ") || "*/*"
          : (response.contentType ?? "application/json"),
      operationName: op.operation.name,
      reason,
    },
    target: response.body?.property ?? op.operation,
  });
}

function incompatibleResponseBodyReason(
  ctx: EmitterCtx,
  response: ResponseVariant,
  kind: Exclude<ResponseEncoderKind, "empty" | "jsonl" | "sse" | "unsupported">,
): string | undefined {
  const body = response.body;
  if (!body) return "a response encoder was selected for an absent body";
  if (body.bodyKind !== "single") return `${body.bodyKind} bodies are not single-value bodies`;

  switch (kind) {
    case "json":
      return undefined;
    case "xml": {
      const serializationType = response.serializationType ?? body.type;
      return unsupportedXmlTypeReason(ctx, serializationType, response.projection);
    }
    case "text": {
      if (body.type.kind === "Scalar") {
        const encoding = resolveScalarEncoding(ctx, body.type, body.property, "text");
        if (encoding.status === "supported") return undefined;
      }
      return isTextResponseType(body.type)
        ? undefined
        : "text responses require a scalar, literal, enum, or union of those types";
    }
    case "bytes":
      if (body.type.kind === "Scalar") {
        const encoding = resolveScalarEncoding(ctx, body.type, body.property, "binary");
        if (encoding.status === "supported") {
          return `binary responses cannot apply scalar encoding ${JSON.stringify(
            encoding.plan.encoding,
          )}; use a textual or JSON media type`;
        }
      }
      return isBytesScalar(body.type)
        ? undefined
        : "binary responses require the TypeSpec bytes scalar";
    case "file":
      return "file responses require a resolved TypeSpec HTTP File body";
  }
}

/**
 * Maps an HTTP response content type to the matching `ResponseEncoders` kind.
 * A concrete media type on a bytes body selects the raw bytes encoder,
 * allowing contracts such as image/png while preserving the declared
 * Content-Type. Malformed types, wildcard ranges, and other unrecognized
 * media types report a hard diagnostic and
 * return `"unsupported"`; callers emit a placeholder encoder that throws at
 * runtime so we never silently coerce a non-conforming response to JSON.
 * Missing content types default to JSON without warning — TypeSpec doesn't
 * require operations to declare one.
 */
function classifyResponseContentType(
  ctx: EmitterCtx,
  op: HttpOperation,
  response: ResponseVariant,
): Exclude<ResponseEncoderKind, "empty" | "jsonl" | "sse"> {
  const contentType = response.contentType;
  if (!contentType) return "json";
  const mediaType = normalizeMediaType(contentType);
  if (!mediaType || isWildcardMediaType(mediaType)) {
    $lib.reportDiagnostic(ctx.program, {
      code: "unsupported-response-content-type",
      format: { contentType, operationName: op.operation.name },
      target: op.operation,
    });
    return "unsupported";
  }
  if (isJsonMediaType(mediaType)) return "json";
  if (isXmlMediaType(mediaType)) return "xml";
  if (isTextMediaType(mediaType)) return "text";
  if (mediaType === "application/octet-stream") return "bytes";
  if (response.body?.bodyKind === "single" && isBytesScalar(response.body.type)) {
    return "bytes";
  }

  $lib.reportDiagnostic(ctx.program, {
    code: "unsupported-response-content-type",
    format: { contentType, operationName: op.operation.name },
    target: op.operation,
  });
  return "unsupported";
}

function isWildcardMediaType(mediaType: string): boolean {
  const [type, subtype] = mediaType.split("/", 2);
  return type === "*" || subtype === "*";
}

function encoderForKind(
  kind: Exclude<ResponseEncoderKind, "unsupported" | "sse">,
  tsType: string,
  status: number,
  contentType: string | undefined,
  bodyTransform?: ResponseBodyTransform,
  streamItemType?: string,
): string {
  switch (kind) {
    case "empty":
      return `ResponseEncoders.empty(${status})`;
    case "text":
      return bodyTransform
        ? `ResponseEncoders.text(${status}).mapInput((value: ${tsType}) => String(${emitResponseBodyTransform("value", bodyTransform)}))`
        : `ResponseEncoders.text(${status})`;
    case "xml":
      if (!contentType || !bodyTransform) {
        throw new Error("XML response encoder emission requires a content type and XML body codec");
      }
      return `ResponseEncoders.xml(${status}, { headers: { "content-type": ${tsLiteral(contentType)} } }).mapInput((value: ${tsType}) => ${emitResponseBodyTransform("value", bodyTransform)})`;
    case "bytes":
      return `ResponseEncoders.bytes(${status})`;
    case "file":
      return `ResponseEncoders.file(${status})`;
    case "json":
      return bodyTransform
        ? `ResponseEncoders.json<unknown>(${status}).mapInput((value: ${tsType}) => ${emitResponseBodyTransform("value", bodyTransform)})`
        : `ResponseEncoders.json<${tsType}>(${status})`;
    case "jsonl": {
      if (!streamItemType) {
        throw new Error("JSONL response encoder emission requires a stream item type");
      }
      const transform = bodyTransform
        ? `, (value) => ${emitResponseBodyTransform("value", bodyTransform)}`
        : "";
      return `ResponseEncoders.jsonl<${streamItemType}>(${status}${transform})`;
    }
  }
}

function responseStreamItemTypeToTs(
  ctx: EmitterCtx,
  response: ResponseVariant,
): string | undefined {
  return response.streamType
    ? payloadTypeToTs(ctx, response.streamType, response.projection)
    : undefined;
}

function emitUnsupportedEncoder(
  resultType: string,
  operationName: string,
  contentType: string | undefined,
): string {
  return emitUnsupportedEncoderReason(
    resultType,
    `Operation "${operationName}" declares unsupported response content type "${contentType ?? ""}". ` +
      `@typespex/http-emitter cannot serialize this; regenerate after addressing the diagnostic.`,
  );
}

function emitUnsupportedEncoderReason(resultType: string, reason: string): string {
  return `ResponseEncoders.unsupported<${resultType}>(${tsLiteral(reason)})`;
}
