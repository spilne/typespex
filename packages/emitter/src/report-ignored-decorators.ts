import type { Model, ModelProperty, Scalar, Type, Union } from "@typespec/compiler";
import {
  getDiscriminatedUnion,
  getEncode,
  isArrayModelType,
  isRecordModelType,
  resolveEncodedName,
  walkPropertiesInherited,
} from "@typespec/compiler";
import type { HttpOperation } from "@typespec/http";
import { getAuthenticationForOperation } from "@typespec/http";
import type { EmitterCtx } from "./ctx.js";
import { $lib } from "./lib.js";
import { isTypeSpecNamespaceModel } from "./type-reference.js";

const VISIBILITY_DECORATOR_NAMES = new Set([
  "@visibility",
  "@invisible",
  "@removeVisibility",
]);

/**
 * Reports diagnostics for decorators the emitter does not implement yet but
 * which change the wire contract or type shapes. Without these, a spec using
 * @encode, @encodedName, @discriminated, @visibility, or @useAuth compiles
 * cleanly into a server with silently wrong behavior. Each diagnostic is
 * removed when real support lands (see issues #27, #28, #30, #46, #47).
 */
export function reportIgnoredDecorators(
  ctx: EmitterCtx,
  operations: readonly HttpOperation[],
): void {
  const seen = new Set<Type>();
  let authReported = false;

  for (const op of operations) {
    if (!authReported && getAuthenticationForOperation(ctx.program, op.operation)) {
      $lib.reportDiagnostic(ctx.program, {
        code: "ignored-auth",
        target: ctx.service.namespace,
      });
      authReported = true;
    }

    for (const param of op.parameters.parameters) {
      checkProperty(ctx, param.param);
      walkType(ctx, param.param.type, seen);
    }
    if (op.parameters.body?.type) {
      walkType(ctx, op.parameters.body.type, seen);
    }
    for (const resp of op.responses) {
      walkType(ctx, resp.type, seen);
      for (const content of resp.responses) {
        if (content.body?.type) {
          walkType(ctx, content.body.type, seen);
        }
      }
    }
  }
}

function walkType(ctx: EmitterCtx, type: Type, seen: Set<Type>): void {
  if (seen.has(type)) return;
  seen.add(type);

  switch (type.kind) {
    case "Model":
      walkModel(ctx, type, seen);
      break;
    case "Union":
      checkUnion(ctx, type);
      for (const variant of type.variants.values()) {
        walkType(ctx, variant.type, seen);
      }
      break;
    case "UnionVariant":
    case "ModelProperty":
      walkType(ctx, type.type, seen);
      break;
    case "Tuple":
      for (const value of type.values) {
        walkType(ctx, value, seen);
      }
      break;
    case "Scalar":
      checkScalarEncode(ctx, type);
      break;
    default:
      break;
  }
}

function walkModel(ctx: EmitterCtx, model: Model, seen: Set<Type>): void {
  if (isTypeSpecNamespaceModel(model)) return;
  if (isArrayModelType(ctx.program, model) || isRecordModelType(ctx.program, model)) {
    if (model.indexer) walkType(ctx, model.indexer.value, seen);
    return;
  }
  for (const prop of walkPropertiesInherited(model)) {
    checkProperty(ctx, prop);
    walkType(ctx, prop.type, seen);
  }
}

function checkProperty(ctx: EmitterCtx, prop: ModelProperty): void {
  if (getEncode(ctx.program, prop)) {
    $lib.reportDiagnostic(ctx.program, {
      code: "ignored-encode",
      format: { name: prop.name },
      target: prop,
    });
  }

  if (resolveEncodedName(ctx.program, prop, "application/json") !== prop.name) {
    $lib.reportDiagnostic(ctx.program, {
      code: "ignored-encoded-name",
      format: { name: prop.name },
      target: prop,
    });
  }

  const hasVisibility = prop.decorators.some((dec) =>
    VISIBILITY_DECORATOR_NAMES.has(dec.definition?.name ?? "")
  );
  if (hasVisibility) {
    $lib.reportDiagnostic(ctx.program, {
      code: "ignored-visibility",
      format: { name: prop.name },
      target: prop,
    });
  }
}

function checkScalarEncode(ctx: EmitterCtx, scalar: Scalar): void {
  // Only user-declared @encode matters; walk the inheritance chain so
  // `scalar myStamp extends utcDateTime` with @encode is caught too.
  let current: Scalar | undefined = scalar;
  while (current) {
    if (getEncode(ctx.program, current)) {
      $lib.reportDiagnostic(ctx.program, {
        code: "ignored-encode",
        format: { name: current.name },
        target: scalar,
      });
      return;
    }
    current = current.baseScalar;
  }
}

function checkUnion(ctx: EmitterCtx, union: Union): void {
  const [discriminated] = getDiscriminatedUnion(ctx.program, union);
  if (discriminated) {
    $lib.reportDiagnostic(ctx.program, {
      code: "ignored-discriminated",
      format: { name: union.name ?? "(anonymous)" },
      target: union,
    });
  }
}
