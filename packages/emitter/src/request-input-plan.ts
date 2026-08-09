import type { Model, Type } from "@typespec/compiler";
import type { HttpOperation } from "@typespec/http";
import type { EmitterCtx } from "./ctx.js";
import { $lib } from "./lib.js";
import { getAdditionalPropertiesValue, isNeverAdditionalProperties } from "./model-indexer.js";
import { multipartFlattenedPropertyNames } from "./multipart-input.js";
import {
  getPayloadCollection,
  getRequestBodyProjection,
  payloadModelProperties,
} from "./payload-context.js";

export type RequestBodyInputPlan =
  /**
   * `direct` is used when the operation has no path/query/header/cookie input.
   * `flattened` preserves the existing public handler shape when body fields
   * are disjoint from the other request inputs.
   * `wrapped` keeps colliding values lossless under `propertyName`.
   */
  | { readonly placement: "direct" | "flattened" }
  | { readonly placement: "wrapped"; readonly propertyName: string };

export interface RequestInputPlan {
  readonly requestPropertyNames: readonly string[];
  readonly duplicateRequestPropertyNames: readonly string[];
  readonly body?: RequestBodyInputPlan;
}

/**
 * Computes the one handler-input layout shared by type and decoder emission.
 * Wire names are deliberately kept separate from these source property names:
 * the latter are the keys that can collide in the generated TypeScript object.
 */
export function getRequestInputPlan(ctx: EmitterCtx, op: HttpOperation): RequestInputPlan {
  const requestPropertyNames = op.parameters.parameters.map((param) => param.param.name);
  const duplicateRequestPropertyNames = findDuplicates(requestPropertyNames);
  const body = op.parameters.body;

  if (!body) {
    return { requestPropertyNames, duplicateRequestPropertyNames };
  }

  if (requestPropertyNames.length === 0) {
    return {
      requestPropertyNames,
      duplicateRequestPropertyNames,
      body: { placement: "direct" },
    };
  }

  const bodyPropertyNames = getFlattenedBodyPropertyNames(ctx, op);
  const canFlatten = bodyPropertyNames !== undefined;
  const requestProperties = new Set(requestPropertyNames);
  const collides = bodyPropertyNames?.some((name) => requestProperties.has(name)) === true;

  if (canFlatten && !collides) {
    return {
      requestPropertyNames,
      duplicateRequestPropertyNames,
      body: { placement: "flattened" },
    };
  }

  return {
    requestPropertyNames,
    duplicateRequestPropertyNames,
    body: {
      placement: "wrapped",
      propertyName: allocateBodyPropertyName(requestProperties),
    },
  };
}

/** Reports request-input collisions that cannot be represented losslessly. */
export function reportRequestInputCollisions(
  ctx: EmitterCtx,
  operations: readonly HttpOperation[],
): void {
  for (const op of operations) {
    const plan = getRequestInputPlan(ctx, op);
    for (const name of plan.duplicateRequestPropertyNames) {
      const locations = [
        ...new Set(
          op.parameters.parameters
            .filter((param) => param.param.name === name)
            .map((param) => param.type),
        ),
      ].join(", ");
      $lib.reportDiagnostic(ctx.program, {
        code: "request-input-property-collision",
        format: {
          operation: op.operation.name,
          property: name,
          locations,
        },
        target:
          op.parameters.parameters.filter((param) => param.param.name === name)[1]?.param ??
          op.operation,
      });
    }
  }
}

export function shouldFlattenBodyType(ctx: EmitterCtx, type: Type): type is Model {
  return type.kind === "Model" && getPayloadCollection(ctx, type) === undefined;
}

function getFlattenedBodyPropertyNames(
  ctx: EmitterCtx,
  op: HttpOperation,
): readonly string[] | undefined {
  const body = op.parameters.body;
  if (!body) return undefined;
  if (body.bodyKind === "file") return undefined;

  if ("bodyKind" in body && body.bodyKind === "multipart" && "parts" in body) {
    return multipartFlattenedPropertyNames(body);
  }

  if (!shouldFlattenBodyType(ctx, body.type)) return undefined;
  if (
    getAdditionalPropertiesValue(body.type) !== undefined &&
    !isNeverAdditionalProperties(body.type)
  ) {
    // An indexed body can produce arbitrary top-level keys at runtime. Keep it
    // nested whenever it is combined with path/query/header/cookie input so
    // those independently sourced values can never overwrite one another.
    return undefined;
  }
  const projection = getRequestBodyProjection(ctx, op);
  return payloadModelProperties(body.type, projection).map((property) => property.name);
}

function allocateBodyPropertyName(used: ReadonlySet<string>): string {
  if (!used.has("body")) return "body";

  let suffix = 2;
  while (used.has(`body_${suffix}`)) suffix += 1;
  return `body_${suffix}`;
}

function findDuplicates(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return [...duplicates].sort();
}
