import type { Model, Type } from "@typespec/compiler";
import { isErrorModel } from "@typespec/compiler";
import type { HttpOperation, HttpOperationResponse } from "@typespec/http";
import type { EmitterCtx } from "./ctx.js";
import { typeToTs } from "./type-reference.js";

export interface OperationGroup {
  interfaceName?: string;
  propertyName: string;
  operations: HttpOperation[];
}

const BUILTIN_TYPE_NAMES = new Set([
  "Array", "Record", "string", "int32", "int64", "float32", "float64",
  "boolean", "bytes", "plainDate", "utcDateTime", "offsetDateTime",
  "duration", "url", "numeric", "integer", "float", "decimal",
  "void", "null", "never", "unknown",
]);

export function collectModelImports(
  operations: HttpOperation[],
): string[] {
  const names = new Set<string>();
  for (const op of operations) {
    collectTypeNames(op, names);
  }
  return [...names]
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .sort();
}

function collectTypeNames(
  op: HttpOperation,
  names: Set<string>,
): void {
  for (const param of op.parameters.parameters) {
    addModelName(param.param.type, names);
  }

  if (op.parameters.body?.type) {
    addModelName(op.parameters.body.type, names);
  }

  for (const resp of op.responses) {
    addModelName(resp.type, names);
    for (const respBody of resp.responses) {
      if (respBody.body?.type) {
        addModelName(respBody.body.type, names);
      }
    }
  }
}

function addModelName(
  type: Type,
  names: Set<string>,
): void {
  if (type.kind === "Model" && typeof type.name === "string" && type.name !== "") {
    if (BUILTIN_TYPE_NAMES.has(type.name)) return;
    names.add(type.name);
  }

  if (type.kind === "Union") {
    for (const v of type.variants.values()) {
      addModelName(v.type, names);
    }
  }
}

export function groupOperations(operations: HttpOperation[]): OperationGroup[] {
  const standalone: HttpOperation[] = [];
  const groups = new Map<string, OperationGroup>();

  for (const op of operations) {
    const iface = op.operation.interface;
    if (!iface) {
      standalone.push(op);
      continue;
    }

    if (!groups.has(iface.name)) {
      groups.set(iface.name, {
        interfaceName: iface.name,
        propertyName: iface.name,
        operations: [],
      });
    }

    groups.get(iface.name)!.operations.push(op);
  }

  const ordered: OperationGroup[] = [...groups.values()];
  if (standalone.length > 0) {
    ordered.push({
      propertyName: "__standalone__",
      operations: standalone,
    });
  }

  return ordered;
}

export function buildInputType(ctx: EmitterCtx, op: HttpOperation): string {
  const parts: string[] = [];

  for (const param of op.parameters.parameters) {
    const optional = param.param.optional ? "?" : "";
    parts.push(`${param.param.name}${optional}: ${typeToTs(ctx, param.param.type)}`);
  }

  if (op.parameters.body) {
    const bodyType = op.parameters.body.type;
    if (parts.length === 0 && bodyType.kind === "Model" && bodyType.name) {
      return bodyType.name;
    }

    if (bodyType.kind === "Model") {
      for (const [, prop] of bodyType.properties) {
        const optional = prop.optional ? "?" : "";
        parts.push(`${prop.name}${optional}: ${typeToTs(ctx, prop.type)}`);
      }
    }
  }

  if (parts.length === 0) return "Record<string, never>";
  return `{ ${parts.join("; ")} }`;
}

export function buildSuccessType(ctx: EmitterCtx, op: HttpOperation): string {
  const types: string[] = [];

  for (const resp of op.responses) {
    const isError = resp.type.kind === "Model" && isErrorModel(ctx.program, resp.type);
    if (isError) continue;

    if (resp.type.kind === "Intrinsic" && resp.type.name === "void") {
      types.push("void");
    } else {
      types.push(typeToTs(ctx, resp.type));
    }
  }

  if (types.length === 0) return "void";
  return types.join(" | ");
}

export function buildErrorType(ctx: EmitterCtx, op: HttpOperation): string {
  const types: string[] = [];

  for (const resp of op.responses) {
    const isError = resp.type.kind === "Model" && isErrorModel(ctx.program, resp.type);
    if (!isError) continue;
    types.push(typeToTs(ctx, resp.type));
  }

  if (types.length === 0) return "never";
  return types.join(" | ");
}

export function toColonPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

/** Success encoder — returns an expression string (no `return`, no `;`). */
export function emitSuccessExpression(
  ctx: EmitterCtx,
  op: HttpOperation,
): string {
  let successStatus = 200;
  let isVoid = false;

  for (const resp of op.responses) {
    const isError = resp.type.kind === "Model" && isErrorModel(ctx.program, resp.type);
    if (isError) continue;

    const rawStatus = resp.statusCodes;
    successStatus = typeof rawStatus === "number" ? rawStatus : 200;
    isVoid = resp.type.kind === "Intrinsic" && resp.type.name === "void";
    break;
  }

  if (isVoid) {
    return `new Response(null, { status: ${successStatus === 200 ? 204 : successStatus} })`;
  }
  return `Response.json(output, { status: ${successStatus} })`;
}

/** Error encoder result — either a single expression or a block body. */
export type ErrorEncoderEmission =
  | { readonly kind: "expression"; readonly expression: string }
  | { readonly kind: "block"; readonly lines: readonly string[] };

/** Error encoder — returns expression or block lines. */
export function emitErrorEncoder(
  ctx: EmitterCtx,
  op: HttpOperation,
): ErrorEncoderEmission {
  const errorResponses: Array<{
    statusCode: number;
    model: Model;
  }> = [];

  for (const resp of op.responses) {
    if (resp.type.kind !== "Model" || !isErrorModel(ctx.program, resp.type)) continue;

    const rawStatus = resp.statusCodes;
    const statusCode =
      typeof rawStatus === "number"
        ? rawStatus
        : inferErrorStatusCode(resp.type);

    errorResponses.push({
      statusCode,
      model: resp.type,
    });
  }

  if (errorResponses.length === 0) {
    return { kind: "expression", expression: "absurd(error)" };
  }

  const lines: string[] = [];
  for (const err of errorResponses) {
    const discriminant = findDiscriminant(err.model);
    if (!discriminant) continue;

    lines.push(
      `      if (error != null && typeof error === "object" && ${JSON.stringify(discriminant.field)} in error && (error as Record<string, unknown>).${discriminant.field} === ${JSON.stringify(discriminant.value)}) {`,
    );
    lines.push(`        return Response.json(error, { status: ${err.statusCode} });`);
    lines.push("      }");
  }

  const fallbackStatus = errorResponses[0].statusCode;
  lines.push(`      return Response.json(error, { status: ${fallbackStatus} });`);

  return { kind: "block", lines };
}

function inferErrorStatusCode(model: Model): number {
  const name = (model.name ?? "").toLowerCase();
  if (name.includes("notfound") || name.includes("not_found")) return 404;
  if (name.includes("badrequest") || name.includes("bad_request")) return 400;
  if (name.includes("unauthorized")) return 401;
  if (name.includes("forbidden")) return 403;
  if (name.includes("conflict")) return 409;
  if (name.includes("validation")) return 422;
  return 500;
}

function findDiscriminant(
  model: Model,
): { field: string; value: string | number } | undefined {
  for (const [, prop] of model.properties) {
    if (prop.type.kind === "String") {
      return { field: prop.name, value: prop.type.value };
    }

    if (prop.type.kind === "Number") {
      return { field: prop.name, value: prop.type.value };
    }
  }

  return undefined;
}
