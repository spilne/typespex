import { isArrayModelType, type Model, type Program, type Type } from "@typespec/compiler";
import type { HttpOperation, HttpPayloadBody } from "@typespec/http";
import type { StreamMetadata } from "@typespec/http/experimental";
import { bodyKind, defaultBodyContentTypes, normalizeMediaType } from "./http-media.js";
import type { BridgeStreamAnalysis, HttpPlanningApi } from "./http-planning-types.js";
import { isBytesLike, isScalarLike } from "./http-type-utils.js";
import { hasLiteralFragment } from "./uri-template.js";

export function analyzeBridgeStreams(
  program: Program,
  operations: readonly HttpOperation[],
  api: HttpPlanningApi,
): BridgeStreamAnalysis {
  const elementTypes = new Map<Model, Type>();
  const typeSubstitutions = new Map<Model, Type>();
  const issues: { operation: HttpOperation; message: string }[] = [];
  for (const operation of operations) {
    for (const parameter of operation.parameters.parameters) {
      if (parameter.type === "path" && parameter.style === "fragment") {
        issues.push({
          operation,
          message: `path parameter ${JSON.stringify(parameter.name)} uses fragment style, which is not sent in HTTP requests`,
        });
      }
    }
    if (hasLiteralFragment(operation.uriTemplate)) {
      issues.push({
        operation,
        message: "literal URI fragments are not sent in HTTP requests",
      });
    }
    addMultipartSubstitutions(operation.parameters.body);
    analyzeBody(operation, operation.parameters.body, "request");
    addStream(operation, api.getStreamMetadata(program, operation.parameters), [
      operation.operation.parameters,
      operation.parameters.body?.type,
    ]);
    for (const response of operation.responses) {
      for (const content of response.responses) {
        addMultipartSubstitutions(content.body);
        analyzeBody(operation, content.body, "response");
        addStream(operation, api.getStreamMetadata(program, content), [
          response.type,
          content.body?.type,
        ]);
      }
    }
  }
  return { elementTypes, typeSubstitutions, issues };

  function addMultipartSubstitutions(body: HttpPayloadBody | undefined): void {
    if (body?.bodyKind !== "multipart") return;
    for (const [index, part] of body.parts.entries()) {
      let wrapper: Type | undefined =
        part.partKind === "model"
          ? part.property.type
          : body.type.kind === "Tuple"
            ? body.type.values[index]
            : undefined;
      if (part.multi && wrapper?.kind === "Model" && isArrayModelType(program, wrapper)) {
        wrapper = wrapper.indexer.value;
      }
      if (wrapper?.kind === "Model") typeSubstitutions.set(wrapper, part.body.type);
    }
  }

  function analyzeBody(
    operation: HttpOperation,
    body: HttpPayloadBody | undefined,
    direction: string,
  ): void {
    if (!body) return;
    if (body.bodyKind === "multipart") {
      for (const part of body.parts)
        analyzeBody(operation, part.body, `${direction} multipart part`);
      return;
    }
    if (body.bodyKind === "file") return;
    const contentTypes =
      body.contentTypes.length > 0 ? body.contentTypes : defaultBodyContentTypes(body);
    for (const contentType of contentTypes) {
      const kind = bodyKind(program, body, contentType);
      if (kind === "binary" && !isBytesLike(program, body.type)) {
        addIssue(
          operation,
          `${direction} body ${contentType} is structured but the HTTP bridge has no serializer for that media type`,
        );
      } else if (kind === "text" && !isScalarLike(program, body.type)) {
        addIssue(
          operation,
          `${direction} body ${contentType} is structured; only scalar text bodies are supported`,
        );
      } else if (kind === "form" && body.type.kind !== "Model") {
        addIssue(operation, `${direction} form body must be an object model`);
      }
    }
  }

  function addIssue(operation: HttpOperation, message: string): void {
    if (issues.some((issue) => issue.operation === operation && issue.message === message)) return;
    issues.push({ operation, message });
  }

  function addStream(
    operation: HttpOperation,
    stream: StreamMetadata | undefined,
    associatedTypes: readonly (Type | undefined)[],
  ): void {
    if (!stream) return;
    if (
      stream.contentTypes.length === 0 ||
      stream.contentTypes.some(
        (contentType) => normalizeMediaType(contentType) !== "application/jsonl",
      )
    ) {
      issues.push({
        operation,
        message: "streaming tools require application/jsonl so MCP can expose a bounded array",
      });
      return;
    }
    if (stream.originalType.kind === "Model")
      elementTypes.set(stream.originalType, stream.streamType);
    if (stream.bodyType.kind === "Model") elementTypes.set(stream.bodyType, stream.streamType);
    for (const type of associatedTypes) {
      if (type?.kind === "Model") elementTypes.set(type, stream.streamType);
    }
  }
}
