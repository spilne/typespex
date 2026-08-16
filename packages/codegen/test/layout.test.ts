import { describe, expect, test } from "bun:test";
import { CODEGEN_PLAN_VERSION } from "../src/index.js";
import {
  ArtifactCollisionError,
  ArtifactFormatError,
  assertUniqueArtifactPaths,
  camelCase,
  createServiceLayout,
  formatTypeScriptArtifacts,
  kebabCase,
  pascalCase,
  typescriptIdentifier,
  typescriptProperty,
  typescriptString,
} from "../src/unstable.js";

describe("codegen service layouts", () => {
  test("exposes the versioned public planning contract", () => {
    expect(CODEGEN_PLAN_VERSION).toBe(1);
  });

  test("renders aligned service and artifact name tokens", () => {
    expect(
      createServiceLayout(
        "Pet Store",
        { models: "models", server: "mcp-server" },
        {
          "service-output": "directory",
          "service-folder-pattern": "generated/{service.kebab}",
          "file-name-pattern": "{service.snake}.{file}",
        },
      ),
    ).toEqual({
      outputDir: "generated-pet-store",
      fileNames: {
        models: "pet_store.models",
        server: "pet_store.mcp-server",
      },
    });
  });

  test("detects case-insensitive artifact collisions before writes", () => {
    expect(() =>
      assertUniqueArtifactPaths([
        {
          version: CODEGEN_PLAN_VERSION,
          artifact: "one",
          outputDir: "service",
          fileName: "Models.ts",
          content: "",
        },
        {
          version: CODEGEN_PLAN_VERSION,
          artifact: "two",
          outputDir: "service",
          fileName: "models.ts",
          content: "",
        },
      ]),
    ).toThrow(ArtifactCollisionError);
  });

  test("formats artifacts and identifies the failed artifact", async () => {
    const [formatted] = await formatTypeScriptArtifacts([
      {
        version: CODEGEN_PLAN_VERSION,
        artifact: "models",
        outputDir: "service",
        fileName: "models.ts",
        content: "const x=1",
      },
    ]);
    expect(formatted?.content).toBe("const x = 1;\n");

    const failure = formatTypeScriptArtifacts([
      {
        version: CODEGEN_PLAN_VERSION,
        artifact: "server",
        outputDir: "service",
        fileName: "server.ts",
        content: "const =",
      },
    ]);
    await expect(failure).rejects.toBeInstanceOf(ArtifactFormatError);
    await expect(failure).rejects.toMatchObject({ artifact: "server", fileName: "server.ts" });
  });

  test("normalizes TypeScript identifiers, properties, strings, and case", () => {
    expect(typescriptIdentifier("two words")).toBe("two_words");
    expect(typescriptIdentifier("1value")).toBe("_1value");
    expect(typescriptIdentifier("class")).toBe("class_");
    expect(typescriptIdentifier("---", "fallback")).toBe("___");
    expect(typescriptProperty("valid")).toBe("valid");
    expect(typescriptProperty("default")).toBe('"default"');
    expect(typescriptProperty("two words")).toBe('"two words"');
    expect(typescriptString("<script>\u2028x\u2029</script>")).toBe(
      '"\\u003Cscript\\u003E\\u2028x\\u2029\\u003C/script\\u003E"',
    );
    expect(() => typescriptString(undefined)).toThrow(TypeError);
    expect(pascalCase("HTTPServer_value")).toBe("HTTPServerValue");
    expect(pascalCase("---")).toBe("Value");
    expect(camelCase("Pet Store")).toBe("petStore");
    expect(kebabCase("HTTPServerValue")).toBe("http-server-value");
  });
});
