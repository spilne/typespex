import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RELEASE_PACKAGES,
  assertTagMatches,
  parseArguments,
  validatePackedManifest,
  validateSourceMapDocument,
  validateSourceMaps,
  validateTarEntryTypes,
} from "./release-packages";

const runtime = RELEASE_PACKAGES[0]!;
const internalVersions = new Map(RELEASE_PACKAGES.map((pkg) => [pkg.name, "0.1.1"]));

describe("release package validation", () => {
  test("keeps package-only checks incapable of publishing", () => {
    expect(parseArguments(["--package-check"])).toEqual({
      publish: false,
      provenance: false,
      packageCheckOnly: true,
      tag: undefined,
      outputDirectory: undefined,
    });
    expect(() => parseArguments(["--package-check", "--publish", "--tag", "v0.1.1"])).toThrow(
      "cannot be combined with --publish",
    );
  });

  test("keeps dependency order explicit", () => {
    expect(RELEASE_PACKAGES.map((pkg) => pkg.name)).toEqual([
      "@typespex/runtime",
      "@typespex/emitter",
      "@typespex/shim-bun",
      "@typespex/shim-hono",
      "@typespex/shim-node",
      "@typespex/shim-express",
    ]);
  });

  test("rejects workspace protocol values in packed manifests", () => {
    expect(() =>
      validatePackedManifest(
        {
          name: runtime.name,
          version: "0.1.1",
          license: "MIT",
          files: ["dist", "src", "README.md", "LICENSE"],
          dependencies: { "@typespex/runtime": "workspace:*" },
        },
        runtime,
        internalVersions,
      ),
    ).toThrow("workspace:");
  });

  test("requires embedded source content", () => {
    expect(() =>
      validateSourceMapDocument(
        { version: 3, sources: ["../src/index.ts"], names: [], mappings: "" },
        "index.js.map",
      ),
    ).toThrow("sourcesContent");

    expect(() =>
      validateSourceMapDocument(
        {
          version: 3,
          sources: ["../src/index.ts"],
          sourcesContent: ["export {};"],
          names: [],
          mappings: "",
        },
        "index.js.map",
      ),
    ).not.toThrow();
  });

  test("reports missing or non-directory dist paths as release errors", () => {
    const root = mkdtempSync(join(tmpdir(), "typespex-release-test-"));
    try {
      expect(() => validateSourceMaps(join(root, "missing"), runtime.name, root)).toThrow(
        "dist directory is missing or inaccessible",
      );

      const file = join(root, "dist");
      writeFileSync(file, "not a directory");
      expect(() => validateSourceMaps(file, runtime.name, root)).toThrow(
        "dist path is not a directory",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("requires every package version to match the release tag", () => {
    const packages = RELEASE_PACKAGES.map((definition, index) => ({
      definition,
      manifest: {
        version: index === RELEASE_PACKAGES.length - 1 ? "0.1.2" : "0.1.1",
      },
    }));
    expect(() => assertTagMatches("v0.1.1", packages)).toThrow("@typespex/shim-express");
  });

  test("rejects links before extracting release tarballs", () => {
    expect(() =>
      validateTarEntryTypes(
        ["package/dist/index.js"],
        ["lrwxr-xr-x 0/0 0 Jan 1 00:00 package/dist/index.js -> ../../../outside"],
        runtime.name,
      ),
    ).toThrow("link or special entry");

    expect(() =>
      validateTarEntryTypes(
        ["package/dist/", "package/dist/index.js"],
        [
          "drwxr-xr-x 0/0 0 Jan 1 00:00 package/dist/",
          "-rw-r--r-- 0/0 1 Jan 1 00:00 package/dist/index.js",
        ],
        runtime.name,
      ),
    ).not.toThrow();
  });
});
