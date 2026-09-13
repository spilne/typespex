import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureTestBuild, type TestBuild } from "./test-build.js";

interface PackageManifest {
  name: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  exports: Record<string, unknown>;
}

/** Prepare fixture dependencies before entering timed test cases. */
export function buildFixturePackages(repoRoot: string, packages: readonly string[]): void {
  for (const build of planFixtureBuilds(repoRoot, packages)) ensureTestBuild(build);
}

/** Use package contracts for build order, transitive inputs, and required entry points. */
export function planFixtureBuilds(repoRoot: string, packages: readonly string[]): TestBuild[] {
  const builds = new Map<string, TestBuild>();
  const visiting = new Set<string>();
  const sharedInputs = ["package.json", "bun.lock", "tsconfig.base.json"].map((path) =>
    resolve(repoRoot, path),
  );

  function visit(directory: string): TestBuild {
    const existing = builds.get(directory);
    if (existing) return existing;
    if (visiting.has(directory)) throw new Error(`Fixture build dependency cycle: ${directory}`);
    visiting.add(directory);

    const packageRoot = resolve(repoRoot, "packages", directory);
    const manifestPath = resolve(packageRoot, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
    const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })
      .filter((name) => name.startsWith("@typespex/"))
      .map((name) => visit(name.slice("@typespex/".length)));
    const artifacts = exportedArtifacts(manifest.exports).map((path) => resolve(packageRoot, path));
    if (artifacts.length === 0) throw new Error(`No fixture build artifacts for ${manifest.name}`);

    const build: TestBuild = {
      packageName: manifest.name,
      repoRoot,
      inputs: [
        ...new Set([
          manifestPath,
          resolve(packageRoot, "src"),
          resolve(packageRoot, "tsconfig.json"),
          ...sharedInputs,
          ...dependencies.flatMap((dependency) => dependency.inputs),
        ]),
      ],
      artifacts,
      stamp: resolve(packageRoot, "dist/.test-build-complete"),
      lockDir: resolve(repoRoot, ".context/test-build-locks", directory),
    };
    visiting.delete(directory);
    builds.set(directory, build);
    return build;
  }

  for (const directory of packages) visit(directory);
  return [...builds.values()];
}

function exportedArtifacts(value: unknown): string[] {
  if (typeof value === "string") {
    return value.startsWith("./dist/") ? [value] : [];
  }
  if (value === null || typeof value !== "object") return [];
  return [...new Set(Object.values(value).flatMap(exportedArtifacts))];
}
