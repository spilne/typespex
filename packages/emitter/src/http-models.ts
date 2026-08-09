import type { ModelProperty, Program, Type } from "@typespec/compiler";
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

/** Matches projected or copied properties that originate from the same declaration. */
export function propertiesShareSource(left: ModelProperty, right: ModelProperty): boolean {
  const leftSources = new Set<ModelProperty>();
  let current: ModelProperty | undefined = left;
  while (current) {
    leftSources.add(current);
    current = current.sourceProperty;
  }

  current = right;
  while (current) {
    if (leftSources.has(current)) return true;
    current = current.sourceProperty;
  }
  return false;
}
