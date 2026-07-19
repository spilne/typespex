import type { Program, Type } from "@typespec/compiler";
import { getHttpPart, isOrExtendsHttpFile } from "@typespec/http";

/** Returns the payload carried by the canonical TypeSpec.Http HttpPart model. */
export function getHttpPartType(program: Program, type: Type): Type | undefined {
  return getHttpPart(program, type)?.type;
}

/** Matches the canonical TypeSpec.Http File model and models derived from it. */
export function isHttpFileModel(program: Program, type: Type): boolean {
  return type.kind === "Model" && isOrExtendsHttpFile(program, type);
}

/** Matches the canonical TypeSpec.Http HttpPart model, not a same-named user model. */
export function isHttpPartModel(program: Program, type: Type): boolean {
  return type.kind === "Model" && getHttpPart(program, type) !== undefined;
}
