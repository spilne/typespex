import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RELEASE_PACKAGES,
  RELEASE_PACKAGE_BOUNDARIES,
  RELEASE_PREFLIGHT_COMMANDS,
  assertTagMatches,
  parseArguments,
  validatePackedManifest,
  validatePackageBoundary,
  validateSourceMapDocument,
  validateSourceMaps,
  validateTarEntryTypes,
} from "./release-packages";

const codec = RELEASE_PACKAGES[0]!;
const compilerCore = RELEASE_PACKAGES.find((pkg) => pkg.name === "@typespex/compiler-core")!;
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
      "@typespex/codec",
      "@typespex/http-client",
      "@typespex/compiler-core",
      "@typespex/http-server",
      "@typespex/mcp",
      "@typespex/mcp-server",
      "@typespex/mcp-http-bridge",
      "@typespex/mcp-transport-http",
      "@typespex/mcp-transport-stdio",
      "@typespex/http-emitter",
      "@typespex/mcp-emitter",
      "@typespex/adapter-bun",
      "@typespex/adapter-hono",
      "@typespex/adapter-node",
      "@typespex/adapter-express",
    ]);
  });

  test("keeps every public package dependency boundary explicit", () => {
    expect(Object.keys(RELEASE_PACKAGE_BOUNDARIES).sort()).toEqual(
      RELEASE_PACKAGES.map((pkg) => pkg.name).sort(),
    );
    expect(() =>
      validatePackageBoundary(
        {
          dependencies: {
            "@typespex/http-server": "workspace:*",
            express: "^5.0.0",
          },
          peerDependencies: { hono: "^4.0.0" },
        },
        RELEASE_PACKAGES.find((pkg) => pkg.name === "@typespex/adapter-hono")!,
      ),
    ).toThrow("@typespex/adapter-hono dependencies");
    expect(RELEASE_PACKAGE_BOUNDARIES["@typespex/mcp-http-bridge"]).toEqual({
      dependencies: ["@typespex/codec", "@typespex/http-client"],
      peerDependencies: ["@typespex/mcp-server"],
    });
  });

  test("keeps release preflight aligned with the required quality gates", () => {
    expect(RELEASE_PREFLIGHT_COMMANDS).toEqual([
      { command: "bun", args: ["run", "clean"] },
      { command: "bun", args: ["run", "format:check"] },
      { command: "bun", args: ["run", "audit:dependencies"] },
      { command: "bun", args: ["run", "build"] },
      { command: "bun", args: ["run", "typecheck"] },
      { command: "bun", args: ["run", "check:generated"] },
      { command: "bun", args: ["run", "check:conformance"] },
      { command: "bun", args: ["run", "check:mcp-conformance"] },
      { command: "bun", args: ["run", "test"] },
      { command: "bun", args: ["run", "test:coverage"] },
      { command: "node", args: ["./packages/adapter-node/test/node-smoke.mjs"] },
      { command: "node", args: ["./packages/adapter-express/test/express-smoke.mjs"] },
    ]);
  });

  test("rejects workspace protocol values in packed manifests", () => {
    expect(() =>
      validatePackedManifest(
        {
          name: compilerCore.name,
          version: "0.1.1",
          license: "MIT",
          files: ["dist", "src", "README.md", "LICENSE"],
          dependencies: { "@typespex/codec": "workspace:*", oxfmt: "0.62.0" },
          peerDependencies: { "@typespec/compiler": ">=1.14.0 <2.0.0" },
        },
        compilerCore,
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
      expect(() => validateSourceMaps(join(root, "missing"), codec.name, root)).toThrow(
        "dist directory is missing or inaccessible",
      );

      const file = join(root, "dist");
      writeFileSync(file, "not a directory");
      expect(() => validateSourceMaps(file, codec.name, root)).toThrow(
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
    expect(() => assertTagMatches("v0.1.1", packages)).toThrow("@typespex/adapter-express");
  });

  test("rejects links before extracting release tarballs", () => {
    expect(() =>
      validateTarEntryTypes(
        ["package/dist/index.js"],
        ["lrwxr-xr-x 0/0 0 Jan 1 00:00 package/dist/index.js -> ../../../outside"],
        codec.name,
      ),
    ).toThrow("link or special entry");

    expect(() =>
      validateTarEntryTypes(
        ["package/dist/", "package/dist/index.js"],
        [
          "drwxr-xr-x 0/0 0 Jan 1 00:00 package/dist/",
          "-rw-r--r-- 0/0 1 Jan 1 00:00 package/dist/index.js",
        ],
        codec.name,
      ),
    ).not.toThrow();
  });
});
