import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeScenarioRunnerMetadata } from "./http-conformance-source.ts";

const HTTP_SPECS_VERSION = "0.1.0-alpha.41";
const HTTP_SPECS_INTEGRITY =
  "sha512-/2S4irzCLOz7agQcARQuG5135oS1rV8X2QKXSczI4QewxQ9ZaeFnlQ12uEnNj2dd7wXX3iZz004sDQKXMhxGqA==";
const HTTP_SPECS_PACKAGE = `@typespec/http-specs@${HTTP_SPECS_VERSION}`;
const HTTP_SPECS_TARBALL = `typespec-http-specs-${HTTP_SPECS_VERSION}.tgz`;
const SCENARIOS = [
  "authentication/api-key",
  "authentication/http/custom",
  "authentication/noauth/union",
  "authentication/oauth2",
  "authentication/union",
  "documentation",
  "encode/array",
  "encode/boolean",
  "encode/bytes",
  "encode/datetime",
  "encode/duration",
  "encode/numeric",
  "parameters/basic",
  "parameters/body-optionality",
  "parameters/body-root",
  "parameters/collection-format",
  "parameters/path",
  "parameters/query",
  "parameters/spread",
  "payload/content-negotiation",
  "payload/head",
  "payload/json-merge-patch",
  "payload/media-type",
  "payload/multipart",
  "routes",
  "serialization/encoded-name/json",
  "special-words",
  "type/array",
  "type/dictionary",
  "type/enum/extensible",
  "type/enum/fixed",
  "type/file",
  "type/model/empty",
  "type/model/inheritance/enum-discriminator",
  "type/model/inheritance/nested-discriminator",
  "type/model/inheritance/not-discriminated",
  "type/model/inheritance/recursive",
  "type/model/inheritance/single-discriminator",
  "type/model/usage",
  "type/model/visibility",
  "type/property/nullable",
  "type/property/optionality",
  "type/property/value-types",
  "type/scalar",
  "type/union",
  "type/union/discriminated",
];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compilerCli = resolve(repoRoot, "example/node_modules/@typespec/compiler/cmd/tsp.js");
const emitterDir = resolve(repoRoot, "packages/emitter");
const typeScriptCli = resolve(repoRoot, "packages/shim-node/node_modules/typescript/bin/tsc");
// Keep transformed inputs under the example workspace so TypeSpec resolves the
// same compiler and HTTP library versions used by the repository.
const workDir = mkdtempSync(join(repoRoot, "example/tmp-typespex-http-conformance-"));

try {
  assertFileExists(compilerCli, "TypeSpec compiler");
  assertFileExists(resolve(emitterDir, "dist/index.js"), "built emitter");
  assertFileExists(resolve(repoRoot, "packages/runtime/dist/server.d.ts"), "runtime declarations");
  assertFileExists(typeScriptCli, "TypeScript compiler");

  run(
    "npm",
    ["pack", HTTP_SPECS_PACKAGE, "--ignore-scripts", "--silent", "--pack-destination", workDir],
    "download TypeSpec HTTP scenarios",
  );

  const tarball = resolve(workDir, HTTP_SPECS_TARBALL);
  assertFileExists(tarball, "TypeSpec HTTP scenario tarball");
  verifyIntegrity(tarball);
  run("tar", ["-xzf", tarball, "-C", workDir], "extract TypeSpec HTTP scenarios");

  const packageDir = resolve(workDir, "package");
  const packageMetadata = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8"));
  if (packageMetadata.version !== HTTP_SPECS_VERSION) {
    const actualVersion = packageMetadata.version ?? "an unknown version";
    throw new Error(`Expected ${HTTP_SPECS_PACKAGE}, received ${actualVersion}.`);
  }

  const generatedFiles = [];
  for (const scenario of SCENARIOS) {
    const upstreamSource = resolve(packageDir, "specs", scenario, "main.tsp");
    assertFileExists(upstreamSource, `TypeSpec HTTP scenario ${scenario}`);

    const inputFile = resolve(workDir, "inputs", scenario, "main.tsp");
    mkdirSync(dirname(inputFile), { recursive: true });
    writeFileSync(
      inputFile,
      removeScenarioRunnerMetadata(readFileSync(upstreamSource, "utf8"), scenario),
    );

    const outputDir = resolve(workDir, "generated", scenario);
    run(
      "node",
      [
        compilerCli,
        "compile",
        inputFile,
        "--emit",
        emitterDir,
        "--output-dir",
        outputDir,
        "--warn-as-error",
      ],
      `compile ${scenario}`,
    );

    const scenarioFiles = collectTypeScriptFiles(outputDir);
    if (scenarioFiles.length === 0) {
      throw new Error(`The ${scenario} scenario did not produce TypeScript output.`);
    }
    generatedFiles.push(...scenarioFiles);
    process.stdout.write(`Compiled ${scenario}\n`);
  }

  const tsconfig = resolve(workDir, "tsconfig.generated.json");
  writeFileSync(
    tsconfig,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          esModuleInterop: true,
          isolatedModules: true,
          lib: ["ES2022", "DOM"],
          baseUrl: repoRoot,
          paths: {
            "@typespex/runtime": ["packages/runtime/dist/index.d.ts"],
            "@typespex/runtime/server": ["packages/runtime/dist/server.d.ts"],
          },
        },
        files: generatedFiles,
      },
      null,
      2,
    ),
  );
  run("node", [typeScriptCli, "--project", tsconfig], "typecheck generated conformance output");

  const summary =
    `Typechecked ${generatedFiles.length} generated files from ` +
    `${SCENARIOS.length} TypeSpec HTTP scenarios.\n`;
  process.stdout.write(summary);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function collectTypeScriptFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files.sort();
}

function verifyIntegrity(tarball) {
  const actual = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
  if (actual !== HTTP_SPECS_INTEGRITY) {
    throw new Error(
      `Integrity mismatch for ${relative(repoRoot, tarball)}.\n` +
        `Expected: ${HTTP_SPECS_INTEGRITY}\n` +
        `Actual:   ${actual}`,
    );
  }
}

function assertFileExists(path, description) {
  if (!existsSync(path)) {
    throw new Error(`Missing ${description}: ${path}`);
  }
}

function run(command, args, description) {
  const result = Bun.spawnSync([command, ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode === 0) return;

  throw new Error(
    `Failed to ${description}.\n` +
      `Command: ${[command, ...args].join(" ")}\n` +
      `stdout:\n${result.stdout.toString()}\n` +
      `stderr:\n${result.stderr.toString()}`,
  );
}
