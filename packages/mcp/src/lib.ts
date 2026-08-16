import { createTypeSpecLibrary } from "@typespec/compiler";

export const $lib = createTypeSpecLibrary({
  name: "@typespex/mcp",
  diagnostics: {},
} as const);

export const { createStateSymbol } = $lib;
