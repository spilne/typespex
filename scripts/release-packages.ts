import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface ReleasePackage {
  readonly directory: string;
  readonly name: string;
  readonly imports: readonly string[];
}

/**
 * Publication order is intentional: every package that can depend on the
 * runtime comes after it. Keep this list explicit so adding a workspace cannot
 * silently add it to a release.
 */
export const RELEASE_PACKAGES: readonly ReleasePackage[] = [
  {
    directory: "runtime",
    name: "@typespex/runtime",
    imports: ["@typespex/runtime", "@typespex/runtime/server"],
  },
  {
    directory: "emitter",
    name: "@typespex/emitter",
    imports: ["@typespex/emitter"],
  },
  {
    directory: "shim-bun",
    name: "@typespex/shim-bun",
    imports: ["@typespex/shim-bun"],
  },
  {
    directory: "shim-hono",
    name: "@typespex/shim-hono",
    imports: ["@typespex/shim-hono"],
  },
  {
    directory: "shim-node",
    name: "@typespex/shim-node",
    imports: ["@typespex/shim-node"],
  },
  {
    directory: "shim-express",
    name: "@typespex/shim-express",
    imports: ["@typespex/shim-express"],
  },
] as const;

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly license?: string;
  readonly files?: readonly string[];
  readonly exports?: unknown;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly [key: string]: unknown;
}

interface LoadedPackage {
  readonly definition: ReleasePackage;
  readonly manifest: PackageManifest;
  readonly packageDirectory: string;
}

interface PackedPackage extends LoadedPackage {
  readonly tarball: string;
}

export interface CliOptions {
  readonly publish: boolean;
  readonly provenance: boolean;
  readonly packageCheckOnly: boolean;
  readonly tag?: string;
  readonly outputDirectory?: string;
}

class ReleaseError extends Error {}

export function assertTagMatches(
  tag: string,
  packages: readonly Pick<LoadedPackage, "definition" | "manifest">[],
): void {
  for (const pkg of packages) {
    const expectedTag = `v${requiredString(pkg.manifest.version, `${pkg.definition.name} version`)}`;
    if (tag !== expectedTag) {
      throw new ReleaseError(
        `Release tag ${JSON.stringify(tag)} does not match ${pkg.definition.name} version (${expectedTag}).`,
      );
    }
  }
}

export function validatePackedManifest(
  manifest: PackageManifest,
  expected: ReleasePackage,
  internalVersions: ReadonlyMap<string, string>,
): void {
  if (manifest.name !== expected.name) {
    throw new ReleaseError(
      `${expected.name} tarball has unexpected package name ${JSON.stringify(manifest.name)}.`,
    );
  }

  requiredString(manifest.version, `${expected.name} packed version`);
  if (manifest.license !== "MIT") {
    throw new ReleaseError(`${expected.name} tarball must declare the MIT license.`);
  }

  const files = new Set(manifest.files ?? []);
  for (const required of ["dist", "src", "README.md", "LICENSE"]) {
    if (!files.has(required)) {
      throw new ReleaseError(`${expected.name} package.json files must include ${required}.`);
    }
  }

  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (version.startsWith("workspace:")) {
        throw new ReleaseError(
          `${expected.name} tarball retains ${section}.${name}=${JSON.stringify(version)}.`,
        );
      }

      const internalVersion = internalVersions.get(name);
      if (internalVersion !== undefined && version !== internalVersion) {
        throw new ReleaseError(
          `${expected.name} tarball depends on ${name}@${version}; expected ${internalVersion}.`,
        );
      }
    }
  }

  if (containsWorkspaceProtocol(manifest)) {
    throw new ReleaseError(`${expected.name} tarball contains a workspace: dependency value.`);
  }
}

export function validateSourceMapDocument(
  document: unknown,
  label: string,
  mapFile?: string,
  packageRoot?: string,
): void {
  if (!isRecord(document) || document.version !== 3) {
    throw new ReleaseError(`${label} is not a version 3 source map.`);
  }

  if (
    !Array.isArray(document.sources) ||
    document.sources.length === 0 ||
    document.sources.some((source) => typeof source !== "string")
  ) {
    throw new ReleaseError(`${label} does not name any sources.`);
  }

  const embedsEverySource =
    Array.isArray(document.sourcesContent) &&
    document.sourcesContent.length === document.sources.length &&
    document.sourcesContent.every((source) => typeof source === "string");
  if (embedsEverySource) return;

  if (mapFile === undefined || packageRoot === undefined) {
    throw new ReleaseError(
      `${label} must embed text for every source in sourcesContent or reference packaged source files.`,
    );
  }

  const sourceRoot = typeof document.sourceRoot === "string" ? document.sourceRoot : "";
  for (const source of document.sources as string[]) {
    const sourceFile = resolve(dirname(mapFile), sourceRoot, source);
    const sourcePath = relative(packageRoot, sourceFile);
    if (
      sourcePath === ".." ||
      sourcePath.startsWith(`..${sep}`) ||
      isAbsolute(sourcePath) ||
      !existsSync(sourceFile) ||
      !statSync(sourceFile).isFile()
    ) {
      throw new ReleaseError(
        `${label} source ${JSON.stringify(source)} is neither embedded nor a packaged file.`,
      );
    }
  }
}

function main(): void {
  const options = parseArguments(process.argv.slice(2));
  verifyBunVersion();

  const packages = loadReleasePackages();
  verifySourceManifests(packages);
  if (options.tag !== undefined) assertTagMatches(options.tag, packages);

  if (options.publish) {
    assertVersionsAreUnpublished(packages);
  }

  if (!options.packageCheckOnly) runQualityGates();

  const { path: outputDirectory, removeOnSuccess } = createOutputDirectory(options.outputDirectory);
  let succeeded = false;

  try {
    // Tests may create coordination markers in dist. Rebuild from a clean tree
    // so release tarballs only contain compiler outputs.
    runCommand("bun", ["run", "clean"]);
    runCommand("bun", ["run", "build"]);

    const packed = packAll(packages, outputDirectory);
    validateAllTarballs(packed);
    verifyCleanConsumer(packed);

    if (options.publish) {
      // Close the race between the early registry check and the first write.
      assertVersionsAreUnpublished(packages);
      publishAll(packed, options.provenance, outputDirectory);
    } else if (options.packageCheckOnly) {
      console.log("\nPackage checks passed. No packages were published.");
    } else {
      console.log("\nRelease preflight passed. No packages were published.");
    }

    succeeded = true;
  } finally {
    if (succeeded && removeOnSuccess) {
      rmSync(outputDirectory, { recursive: true, force: true });
    } else if (!succeeded && existsSync(outputDirectory)) {
      console.error(`\nRelease artifacts were kept at ${outputDirectory}`);
    }
  }
}

export function parseArguments(args: readonly string[]): CliOptions {
  let publish = false;
  let provenance = false;
  let packageCheckOnly = false;
  let tag: string | undefined;
  let outputDirectory: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--") continue;

    if (argument === "--publish") {
      publish = true;
    } else if (argument === "--provenance") {
      provenance = true;
    } else if (argument === "--package-check") {
      packageCheckOnly = true;
    } else if (argument === "--tag") {
      tag = requiredArgument(args[++index], "--tag");
    } else if (argument.startsWith("--tag=")) {
      tag = requiredArgument(argument.slice("--tag=".length), "--tag");
    } else if (argument === "--output-dir") {
      outputDirectory = requiredArgument(args[++index], "--output-dir");
    } else if (argument.startsWith("--output-dir=")) {
      outputDirectory = requiredArgument(argument.slice("--output-dir=".length), "--output-dir");
    } else if (argument === "--help" || argument === "-h") {
      console.log(`Usage: ./scripts/publish-packages.sh [options]

By default the command runs every release gate and packs every package without
publishing. Registry writes require --publish.

Options:
  --tag v<version>       Validate the tag against every package version
  --output-dir <path>    Keep validated tarballs in an empty directory
  --package-check        Run only artifact and clean-consumer checks; never publish
  --publish              Publish the validated tarballs in dependency order
  --provenance           Pass --provenance to npm publish
`);
      process.exit(0);
    } else {
      throw new ReleaseError(`Unknown release option: ${argument}`);
    }
  }

  const options = { publish, provenance, packageCheckOnly, tag, outputDirectory };
  validateCliOptions(options);
  return options;
}

export function validateCliOptions(options: CliOptions): void {
  if (options.packageCheckOnly && options.publish) {
    throw new ReleaseError("--package-check cannot be combined with --publish.");
  }
  if (options.publish && options.tag === undefined) {
    throw new ReleaseError("Publishing requires --tag v<version>.");
  }
  if (options.provenance && !options.publish) {
    throw new ReleaseError("--provenance is only valid together with --publish.");
  }
}

function verifyBunVersion(): void {
  const rootManifest = readJson<PackageManifest>(join(REPOSITORY_ROOT, "package.json"));
  const packageManager = requiredString(rootManifest.packageManager, "root packageManager");
  const match = /^bun@(.+)$/.exec(packageManager);
  if (match === null) {
    throw new ReleaseError(`Expected packageManager to pin Bun, received ${packageManager}.`);
  }

  const runningVersion = process.versions.bun;
  if (runningVersion !== match[1]) {
    throw new ReleaseError(
      `Release requires Bun ${match[1]}, but the running version is ${runningVersion ?? "not Bun"}.`,
    );
  }
}

function loadReleasePackages(): LoadedPackage[] {
  const packages = RELEASE_PACKAGES.map((definition) => {
    const packageDirectory = join(REPOSITORY_ROOT, "packages", definition.directory);
    const manifest = readJson<PackageManifest>(join(packageDirectory, "package.json"));
    if (manifest.name !== definition.name) {
      throw new ReleaseError(
        `${relative(REPOSITORY_ROOT, packageDirectory)} is ${JSON.stringify(manifest.name)}, expected ${definition.name}.`,
      );
    }
    requiredString(manifest.version, `${definition.name} version`);
    return { definition, manifest, packageDirectory };
  });

  const configuredDirectories = new Set(RELEASE_PACKAGES.map((pkg) => pkg.directory));
  const unconfigured = readdirSync(join(REPOSITORY_ROOT, "packages"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory() && !configuredDirectories.has(entry.name))
    .filter((entry) => {
      const manifestPath = join(REPOSITORY_ROOT, "packages", entry.name, "package.json");
      if (!existsSync(manifestPath)) return false;
      return readJson<PackageManifest>(manifestPath).private !== true;
    })
    .map((entry) => entry.name);
  if (unconfigured.length > 0) {
    throw new ReleaseError(
      `Publishable package directories are missing from RELEASE_PACKAGES: ${unconfigured.join(", ")}.`,
    );
  }

  return packages;
}

function verifySourceManifests(packages: readonly LoadedPackage[]): void {
  const versions = internalVersionMap(packages);
  const releaseVersions = new Set(versions.values());
  if (releaseVersions.size !== 1) {
    throw new ReleaseError(
      `All release packages must use one version; received ${Array.from(releaseVersions).join(", ")}.`,
    );
  }

  for (const pkg of packages) {
    const version = requiredString(pkg.manifest.version, `${pkg.definition.name} version`);
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new ReleaseError(`${pkg.definition.name} has unsupported release version ${version}.`);
    }

    for (const internalName of versions.keys()) {
      const dependencyVersion = pkg.manifest.dependencies?.[internalName];
      if (dependencyVersion !== undefined && dependencyVersion !== "workspace:*") {
        throw new ReleaseError(
          `${pkg.definition.name} source dependency on ${internalName} must use workspace:*; received ${dependencyVersion}.`,
        );
      }
    }
  }
}

function runQualityGates(): void {
  console.log("\nRunning release quality gates...");
  runCommand("bun", ["run", "clean"]);
  runCommand("bun", ["run", "build"]);
  runCommand("bun", ["run", "typecheck"]);
  runCommand("bun", ["run", "check:generated"]);
  runCommand("bun", ["test"]);
  runCommand("node", ["./packages/shim-node/test/node-smoke.mjs"]);
}

function createOutputDirectory(requested?: string): {
  readonly path: string;
  readonly removeOnSuccess: boolean;
} {
  if (requested === undefined) {
    return {
      path: mkdtempSync(join(tmpdir(), "typespex-release-")),
      removeOnSuccess: true,
    };
  }

  const path = resolve(REPOSITORY_ROOT, requested);
  if (existsSync(path)) {
    if (!statSync(path).isDirectory()) {
      throw new ReleaseError(`Release output path is not a directory: ${path}`);
    }
    if (readdirSync(path).length !== 0) {
      throw new ReleaseError(`Release output directory must be empty: ${path}`);
    }
  } else {
    mkdirSync(path, { recursive: true });
  }

  return { path, removeOnSuccess: false };
}

function packAll(packages: readonly LoadedPackage[], outputDirectory: string): PackedPackage[] {
  console.log("\nPacking all release artifacts...");
  const packed: PackedPackage[] = [];
  const knownFiles = new Set(readdirSync(outputDirectory));

  for (const pkg of packages) {
    console.log(`\nPacking ${pkg.definition.name}`);
    runCommand(
      "bun",
      ["pm", "pack", "--ignore-scripts", "--quiet", "--destination", outputDirectory],
      pkg.packageDirectory,
    );

    const newFiles = readdirSync(outputDirectory).filter((file) => !knownFiles.has(file));
    if (newFiles.length !== 1 || !newFiles[0]!.endsWith(".tgz")) {
      throw new ReleaseError(
        `${pkg.definition.name} packing produced unexpected files: ${newFiles.join(", ") || "(none)"}.`,
      );
    }

    const file = newFiles[0]!;
    knownFiles.add(file);
    packed.push({ ...pkg, tarball: join(outputDirectory, file) });
  }

  return packed;
}

function validateAllTarballs(packages: readonly PackedPackage[]): void {
  console.log("\nValidating every tarball before publication...");
  const versions = internalVersionMap(packages);
  const rootLicense = readFileSync(join(REPOSITORY_ROOT, "LICENSE"), "utf8");

  for (const pkg of packages) {
    const extractionDirectory = mkdtempSync(join(tmpdir(), "typespex-packed-"));
    try {
      const entries = captureCommand("tar", ["-tzf", pkg.tarball]).split(/\r?\n/).filter(Boolean);
      const verboseEntries = captureCommand("tar", ["-tvzf", pkg.tarball])
        .split(/\r?\n/)
        .filter(Boolean);
      validateTarEntries(entries, pkg.definition.name);
      validateTarEntryTypes(entries, verboseEntries, pkg.definition.name);
      runCommand("tar", ["-xzf", pkg.tarball, "-C", extractionDirectory]);

      const root = join(extractionDirectory, "package");
      const manifest = readJson<PackageManifest>(join(root, "package.json"));
      validatePackedManifest(manifest, pkg.definition, versions);
      if (manifest.version !== pkg.manifest.version) {
        throw new ReleaseError(
          `${pkg.definition.name} tarball version ${manifest.version} does not match source ${pkg.manifest.version}.`,
        );
      }

      const readme = readFileSync(join(root, "README.md"), "utf8");
      if (
        !readme.includes(pkg.definition.name) ||
        !readme.includes("## Entry points") ||
        !readme.includes("## Runtime requirements")
      ) {
        throw new ReleaseError(
          `${pkg.definition.name} README must document its name, entry points, and runtime requirements.`,
        );
      }
      if (readFileSync(join(root, "LICENSE"), "utf8") !== rootLicense) {
        throw new ReleaseError(
          `${pkg.definition.name} LICENSE differs from the repository license.`,
        );
      }

      validateExportTargets(manifest.exports, root, pkg.definition.name);
      validateSourceMaps(join(root, "dist"), pkg.definition.name, root);
      console.log(`Validated ${basename(pkg.tarball)}`);
    } finally {
      rmSync(extractionDirectory, { recursive: true, force: true });
    }
  }
}

/** Reject links and special files before extracting a release archive. */
export function validateTarEntryTypes(
  entries: readonly string[],
  verboseEntries: readonly string[],
  packageName: string,
): void {
  if (entries.length !== verboseEntries.length) {
    throw new ReleaseError(
      `${packageName} tarball listing changed between name and type inspection.`,
    );
  }

  for (let index = 0; index < entries.length; index += 1) {
    const type = verboseEntries[index]?.[0];
    if (type !== "-" && type !== "d") {
      throw new ReleaseError(
        `${packageName} tarball contains a link or special entry: ${entries[index]}.`,
      );
    }
  }
}

function validateTarEntries(entries: readonly string[], packageName: string): void {
  const required = new Set(["package/package.json", "package/README.md", "package/LICENSE"]);

  for (const entry of entries) {
    const normalized = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    const segments = normalized.split("/");
    if (
      normalized.startsWith("/") ||
      segments.includes("..") ||
      (normalized !== "package" &&
        normalized !== "package/dist" &&
        !normalized.startsWith("package/dist/") &&
        normalized !== "package/src" &&
        !normalized.startsWith("package/src/") &&
        !required.has(normalized))
    ) {
      throw new ReleaseError(`${packageName} tarball contains unexpected entry ${entry}.`);
    }

    if (
      normalized.includes("/test/") ||
      normalized.endsWith(".tsbuildinfo") ||
      basename(normalized).startsWith(".test-build-")
    ) {
      throw new ReleaseError(`${packageName} tarball contains repository-only entry ${entry}.`);
    }
    required.delete(normalized);
  }

  if (required.size > 0) {
    throw new ReleaseError(
      `${packageName} tarball is missing ${Array.from(required).sort().join(", ")}.`,
    );
  }
}

function validateExportTargets(
  exportsValue: unknown,
  packageRoot: string,
  packageName: string,
): void {
  const targets: string[] = [];
  collectExportTargets(exportsValue, targets);
  if (targets.length === 0) {
    throw new ReleaseError(`${packageName} does not expose any package entry points.`);
  }

  for (const target of targets) {
    if (!target.startsWith("./dist/")) {
      throw new ReleaseError(`${packageName} export target is outside dist: ${target}.`);
    }
    if (!existsSync(join(packageRoot, target))) {
      throw new ReleaseError(
        `${packageName} export target is missing from its tarball: ${target}.`,
      );
    }
  }
}

function collectExportTargets(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
  } else if (isRecord(value)) {
    for (const child of Object.values(value)) collectExportTargets(child, output);
  }
}

export function validateSourceMaps(
  distDirectory: string,
  packageName: string,
  packageRoot: string,
): void {
  let distEntry: ReturnType<typeof statSync>;
  try {
    distEntry = statSync(distDirectory);
  } catch (error) {
    const reason = error instanceof Error ? `: ${error.message}` : "";
    throw new ReleaseError(
      `${packageName} dist directory is missing or inaccessible (${distDirectory})${reason}`,
    );
  }
  if (!distEntry.isDirectory()) {
    throw new ReleaseError(`${packageName} dist path is not a directory: ${distDirectory}.`);
  }

  const files = listFiles(distDirectory);
  const maps = files.filter((file) => file.endsWith(".map"));
  if (!maps.some((file) => file.endsWith(".js.map"))) {
    throw new ReleaseError(`${packageName} tarball does not contain JavaScript source maps.`);
  }
  if (!maps.some((file) => file.endsWith(".d.ts.map"))) {
    throw new ReleaseError(`${packageName} tarball does not contain declaration source maps.`);
  }

  for (const mapFile of maps) {
    const label = `${packageName}:${relative(distDirectory, mapFile)}`;
    validateSourceMapDocument(readJson<unknown>(mapFile), label, mapFile, packageRoot);

    const generatedFile = mapFile.slice(0, -".map".length);
    if (!existsSync(generatedFile)) {
      throw new ReleaseError(`${label} has no corresponding generated file.`);
    }
    const generated = readFileSync(generatedFile, "utf8");
    if (!generated.includes(`sourceMappingURL=${basename(mapFile)}`)) {
      throw new ReleaseError(`${label} is not referenced by its generated file.`);
    }
  }
}

function verifyCleanConsumer(packages: readonly PackedPackage[]): void {
  console.log("\nInstalling every tarball into a clean npm consumer...");
  const consumerDirectory = mkdtempSync(join(tmpdir(), "typespex-consumer-"));

  try {
    const dependencies = Object.fromEntries(
      packages.map((pkg) => [pkg.definition.name, `file:${pkg.tarball}`]),
    );
    writeFileSync(
      join(consumerDirectory, "package.json"),
      `${JSON.stringify(
        {
          name: "typespex-release-consumer",
          private: true,
          type: "module",
          dependencies,
        },
        null,
        2,
      )}\n`,
    );

    runCommand(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"],
      consumerDirectory,
    );

    const versions = internalVersionMap(packages);
    for (const pkg of packages) {
      const installedRoot = join(
        consumerDirectory,
        "node_modules",
        ...pkg.definition.name.split("/"),
      );
      validatePackedManifest(
        readJson<PackageManifest>(join(installedRoot, "package.json")),
        pkg.definition,
        versions,
      );
      if (
        !existsSync(join(installedRoot, "README.md")) ||
        !existsSync(join(installedRoot, "LICENSE"))
      ) {
        throw new ReleaseError(
          `${pkg.definition.name} clean installation is missing README.md or LICENSE.`,
        );
      }
      validateSourceMaps(
        join(installedRoot, "dist"),
        `${pkg.definition.name} clean installation`,
        installedRoot,
      );
    }

    const imports = packages.flatMap((pkg) => pkg.definition.imports);
    const program = `for (const specifier of ${JSON.stringify(
      imports,
    )}) { await import(specifier); console.log("Imported " + specifier); }`;
    runCommand("node", ["--input-type=module", "--eval", program], consumerDirectory);
  } finally {
    rmSync(consumerDirectory, { recursive: true, force: true });
  }
}

function assertVersionsAreUnpublished(packages: readonly LoadedPackage[]): void {
  console.log("\nChecking that every release version is unused...");
  const existing: string[] = [];

  for (const pkg of packages) {
    const version = requiredString(pkg.manifest.version, `${pkg.definition.name} version`);
    const specifier = `${pkg.definition.name}@${version}`;
    if (registryVersionExists(specifier)) existing.push(specifier);
  }

  if (existing.length > 0) {
    throw new ReleaseError(
      `Refusing to publish versions that already exist:\n${existing.map((item) => `  - ${item}`).join("\n")}`,
    );
  }
}

function registryVersionExists(specifier: string): boolean {
  const result = spawnSync("npm", ["view", specifier, "version", "--json"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
  if (result.status === 0) return true;

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/\bE404\b|404 Not Found/i.test(output)) return false;
  throw new ReleaseError(
    `Could not check ${specifier} in the npm registry:\n${output.trim() || `npm exited ${result.status}`}`,
  );
}

function publishAll(
  packages: readonly PackedPackage[],
  provenance: boolean,
  outputDirectory: string,
): void {
  console.log("\nAll release gates passed. Publishing preflighted tarballs...");
  const published: string[] = [];

  for (let index = 0; index < packages.length; index += 1) {
    const pkg = packages[index]!;
    const version = requiredString(pkg.manifest.version, `${pkg.definition.name} version`);
    const args = ["publish", pkg.tarball, "--access", "public"];
    if (provenance) args.push("--provenance");

    try {
      runCommand("npm", args);
      published.push(`${pkg.definition.name}@${version}`);
    } catch (error) {
      const remaining = packages.slice(index).map((item) => {
        const itemVersion = requiredString(
          item.manifest.version,
          `${item.definition.name} version`,
        );
        return `${item.definition.name}@${itemVersion}`;
      });
      console.error(`
Publication stopped after a registry failure.

Already completed:
${published.length === 0 ? "  (none)" : published.map((item) => `  - ${item}`).join("\n")}

Not confirmed:
${remaining.map((item) => `  - ${item}`).join("\n")}

Recovery:
  1. Inspect each version with \`npm view <name>@<version>\`; a failed
     response can still have reached the registry.
  2. Keep the validated tarballs in ${outputDirectory}.
  3. Never retry a package version that the registry accepted. If every
     published artifact is correct, publish only the remaining preflighted
     tarballs in the order shown above.
  4. If artifact identity is uncertain, stop and prepare a new version and
     release tag instead of attempting to overwrite an immutable version.
`);
      throw error;
    }
  }

  console.log("\nAll packages published.");
}

function internalVersionMap(
  packages: readonly Pick<LoadedPackage, "definition" | "manifest">[],
): Map<string, string> {
  return new Map(
    packages.map((pkg) => [
      pkg.definition.name,
      requiredString(pkg.manifest.version, `${pkg.definition.name} version`),
    ]),
  );
}

function containsWorkspaceProtocol(value: unknown): boolean {
  if (typeof value === "string") return value.startsWith("workspace:");
  if (Array.isArray(value)) return value.some(containsWorkspaceProtocol);
  if (isRecord(value)) return Object.values(value).some(containsWorkspaceProtocol);
  return false;
}

function listFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function runCommand(command: string, args: readonly string[], cwd = REPOSITORY_ROOT): void {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new ReleaseError(`${command} exited with status ${result.status ?? "unknown"}.`);
  }
}

function captureCommand(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new ReleaseError(
      `${command} exited with status ${result.status ?? "unknown"}:\n${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new ReleaseError(
      `Could not read JSON from ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ReleaseError(`Expected ${label} to be a non-empty string.`);
  }
  return value;
}

function requiredArgument(value: string | undefined, flag: string): string {
  if (value === undefined || value.length === 0) {
    throw new ReleaseError(`${flag} requires a value.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    const workflow = process.argv.includes("--package-check") ? "Package check" : "Release";
    console.error(`\n${workflow} failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
