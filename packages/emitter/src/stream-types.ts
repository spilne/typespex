import type { Program, Type } from "@typespec/compiler";

const streamOfState = Symbol.for("@typespec/streams/streamOf");

/** Returns whether a model carries the standard TypeSpec typed-stream contract. */
export function isTypedStream(program: Program, type: Type | undefined): boolean {
  return type?.kind === "Model" && program.stateMap(streamOfState).has(type);
}
