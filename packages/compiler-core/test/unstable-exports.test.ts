import { expect, test } from "bun:test";
import * as compiler from "../src/unstable.js";

test("keeps compiler-author exports deliberate and internal planners private", () => {
  expect(Object.keys(compiler).sort()).toEqual(
    [
      "ArtifactCollisionError",
      "ArtifactFormatError",
      "COMPILER_PLAN_VERSION",
      "TypePlanner",
      "assertUniqueArtifactPaths",
      "camelCase",
      "createServiceLayout",
      "formatTypeScriptArtifacts",
      "getEffectiveScalarEncoding",
      "getScalarEncodingIssue",
      "getScalarIntrinsicName",
      "isIntegerIntrinsic",
      "isJsonSafeIntegerRange",
      "isNumericIntrinsic",
      "isVoidType",
      "kebabCase",
      "pascalCase",
      "renderTypeScriptModule",
      "typescriptIdentifier",
      "typescriptProperty",
      "typescriptString",
    ].sort(),
  );
});
