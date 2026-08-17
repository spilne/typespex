/**
 * Builds handler-facing request input types from TypeSpec HTTP operations.
 */
import type { HttpOperation } from "@typespec/http";
import type { EmitterCtx } from "./ctx.js";
import { multipartBodyTypeToTs, multipartModelPropertyDeclarations } from "./multipart-input.js";
import {
  getRequestBodyProjection,
  payloadModelProperties,
  payloadPropertyOptional,
  payloadTypeToTs,
} from "./payload-context.js";
import { getRequestInputPlan, shouldFlattenBodyType } from "./request-input-plan.js";
import { getHandlerRequestParameters, getJsonlRequestStream } from "./request-streams.js";
import { typeToTs } from "./type-reference.js";
import { tsPropertyDeclaration } from "./typescript-names.js";

export function buildInputType(ctx: EmitterCtx, op: HttpOperation): string {
  const parts: string[] = [];
  const inputPlan = getRequestInputPlan(ctx, op);

  for (const param of getHandlerRequestParameters(ctx, op)) {
    parts.push(
      tsPropertyDeclaration(param.param.name, typeToTs(ctx, param.param.type), {
        optional: param.param.optional,
      }),
    );
  }

  if (op.parameters.body) {
    const body = op.parameters.body;
    const hasNonBodyInput = parts.length > 0;
    const requestStream = getJsonlRequestStream(ctx, op);

    if (requestStream) {
      const projection = getRequestBodyProjection(ctx, op);
      const streamType = `AsyncIterable<${payloadTypeToTs(
        ctx,
        requestStream.streamType,
        projection,
      )}>`;
      if (!hasNonBodyInput) return streamType;

      const propertyName =
        inputPlan.body?.placement === "wrapped" ? inputPlan.body.propertyName : "body";
      parts.push(tsPropertyDeclaration(propertyName, streamType));
      return `{ ${parts.join("; ")} }`;
    }

    // Multipart body — build type from parts
    if ("bodyKind" in body && body.bodyKind === "multipart" && "parts" in body) {
      const bodyOptional = body.property?.optional === true;
      if (inputPlan.body?.placement === "wrapped") {
        const multipartType = multipartBodyTypeToTs(ctx, body);
        parts.push(
          tsPropertyDeclaration(inputPlan.body.propertyName, multipartType, {
            optional: bodyOptional,
          }),
        );
        return `{ ${parts.join("; ")} }`;
      }
      if (bodyOptional && !hasNonBodyInput) {
        const multipartType = multipartBodyTypeToTs(ctx, body);
        return `${multipartType} | undefined`;
      }
      if (body.multipartKind === "tuple") {
        return multipartBodyTypeToTs(ctx, body);
      }
      parts.push(...multipartModelPropertyDeclarations(ctx, body, bodyOptional && hasNonBodyInput));
    } else {
      const bodyType = body.type;
      const bodyOptional = body.property?.optional === true;
      const projection = getRequestBodyProjection(ctx, op);
      // Materialize the complete projected reference even when the public
      // handler shape is flattened. Recursive decoder declarations may need
      // the projection-specific alias registered by this call.
      const bodyTypeTs = payloadTypeToTs(ctx, bodyType, projection);
      if (parts.length === 0) {
        return bodyOptional ? `${bodyTypeTs} | undefined` : bodyTypeTs;
      }

      if (inputPlan.body?.placement === "flattened" && shouldFlattenBodyType(ctx, bodyType)) {
        for (const prop of payloadModelProperties(bodyType, projection)) {
          parts.push(
            tsPropertyDeclaration(prop.name, payloadTypeToTs(ctx, prop.type, projection), {
              optional: bodyOptional || payloadPropertyOptional(prop, projection),
            }),
          );
        }
      } else {
        parts.push(
          tsPropertyDeclaration(
            inputPlan.body?.placement === "wrapped" ? inputPlan.body.propertyName : "body",
            bodyTypeTs,
            {
              optional: bodyOptional,
            },
          ),
        );
      }
    }
  }

  if (parts.length === 0) return "Record<string, never>";
  return `{ ${parts.join("; ")} }`;
}
