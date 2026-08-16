import type { Entity } from "@typespec/compiler";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isEntityLike(value: unknown): value is Entity {
  return isObject(value) && "entityKind" in value;
}
