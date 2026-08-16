import { execFileSync } from "node:child_process";

const MINIMUM_TYPESPEC_VERSION = "1.14.0";
const TYPESPEC_PACKAGES = ["@typespec/compiler", "@typespec/http"];

function readPublishedVersions(packageName) {
  const output = execFileSync("npm", ["view", packageName, "versions", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function stableVersionParts(version) {
  const match = /^(1)\.(\d+)\.(\d+)$/.exec(version);
  return match === null ? undefined : match.slice(1).map(Number);
}

function compareStableVersions(left, right) {
  const leftParts = stableVersionParts(left);
  const rightParts = stableVersionParts(right);
  if (leftParts === undefined || rightParts === undefined) {
    throw new Error("Only stable TypeSpec 1.x versions can be compared.");
  }

  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function resolveLatestAlignedVersion() {
  const [compilerVersions, httpVersions] = TYPESPEC_PACKAGES.map(readPublishedVersions);
  const httpVersionSet = new Set(httpVersions);
  const sharedStableVersions = compilerVersions
    .filter((version) => stableVersionParts(version) !== undefined)
    .filter((version) => httpVersionSet.has(version))
    .sort(compareStableVersions);
  const latest = sharedStableVersions.at(-1);
  if (latest === undefined) {
    throw new Error("No stable TypeSpec 1.x release is shared by compiler and HTTP packages.");
  }
  return latest;
}

const channel = process.argv[2];
if (channel === "minimum") {
  process.stdout.write(MINIMUM_TYPESPEC_VERSION);
} else if (channel === "latest") {
  process.stdout.write(resolveLatestAlignedVersion());
} else {
  throw new Error(
    `Expected TypeSpec channel "minimum" or "latest", received ${channel ?? "none"}.`,
  );
}
