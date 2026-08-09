import { describe, expect, test } from "bun:test";
import {
  GeneratedFileFormatError,
  formatGeneratedFiles,
  formatGeneratedTypeScript,
} from "../src/format-generated.js";

describe("generated TypeScript formatting", () => {
  test("formats valid generated TypeScript", async () => {
    expect(await formatGeneratedTypeScript("generated.ts", "export const value={answer:42};")).toBe(
      "export const value = { answer: 42 };\n",
    );
  });

  test("rejects generated TypeScript with formatter parse errors", async () => {
    await expect(formatGeneratedTypeScript("generated.ts", "export interface {")).rejects.toThrow();
  });

  test("rejects the complete plan with the failing artifact context", async () => {
    const calls: string[] = [];
    const files = [
      { fileName: "models.ts", outputDir: "api", raw: "models" },
      { fileName: "server.ts", outputDir: "api", raw: "server" },
      { fileName: "server-router.ts", outputDir: "api", raw: "router" },
    ];

    try {
      await formatGeneratedFiles(files, async (fileName, content) => {
        calls.push(fileName);
        if (fileName === "server.ts") throw new Error("formatter unavailable");
        return `formatted ${content}`;
      });
      throw new Error("Expected formatting to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(GeneratedFileFormatError);
      expect(error).toMatchObject({
        fileName: "server.ts",
        outputDir: "api",
        message: "formatter unavailable",
      });
    }
    expect(calls).toEqual(["models.ts", "server.ts"]);
  });
});
