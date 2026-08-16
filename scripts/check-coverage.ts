import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_COVERAGE_FILE = ".context/coverage/lcov.info";
const COVERAGE_ROOTS = [
  "packages/codec/src",
  "packages/http-client/src",
  "packages/compiler-core/src",
  "packages/http-server/src",
  "packages/mcp-server/src",
  "packages/mcp-http-bridge/src",
  "packages/mcp-transport-http/src",
  "packages/mcp-transport-stdio/src",
  "packages/adapter-bun/src",
  "packages/adapter-express/src",
  "packages/adapter-hono/src",
  "packages/adapter-node/src",
] as const;

export interface CoverageThresholds {
  readonly functions: number;
  readonly lines: number;
}

export interface CoverageSummary {
  readonly files: number;
  readonly functions: { readonly found: number; readonly hit: number; readonly ratio: number };
  readonly lines: { readonly found: number; readonly hit: number; readonly ratio: number };
}

interface CoverageRecord {
  readonly source: string;
  readonly functionsFound: number;
  readonly functionsHit: number;
  readonly linesFound: number;
  readonly linesHit: number;
}

export const AGGREGATE_COVERAGE_THRESHOLDS: CoverageThresholds = {
  functions: 0.94,
  lines: 0.95,
};

export const PER_FILE_COVERAGE_THRESHOLDS: CoverageThresholds = {
  functions: 0.7,
  lines: 0.8,
};

export function parseLcov(content: string): ReadonlyMap<string, CoverageRecord> {
  const records = new Map<string, CoverageRecord>();
  for (const section of content.split("end_of_record")) {
    const lines = section
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const sourceLine = lines.find((line) => line.startsWith("SF:"));
    if (!sourceLine) continue;

    const source = normalizeSource(sourceLine.slice(3));
    if (records.has(source)) {
      throw new Error(`Duplicate LCOV record: ${source}`);
    }
    const record = {
      source,
      functionsFound: readMetric(lines, "FNF", source),
      functionsHit: readMetric(lines, "FNH", source),
      linesFound: readMetric(lines, "LF", source),
      linesHit: readMetric(lines, "LH", source),
    };
    validateRecord(record);
    records.set(source, record);
  }
  if (records.size === 0) throw new Error("The LCOV report contains no source records.");
  return records;
}

export function validateCoverage(
  content: string,
  requiredSources: readonly string[],
  thresholds: CoverageThresholds = AGGREGATE_COVERAGE_THRESHOLDS,
  perFileThresholds: CoverageThresholds = PER_FILE_COVERAGE_THRESHOLDS,
): CoverageSummary {
  validateThresholds(thresholds);
  validateThresholds(perFileThresholds);
  const records = parseLcov(content);
  const normalizedSources = requiredSources.map(normalizeSource);
  const missing = normalizedSources.filter((source) => !records.has(source));
  if (missing.length > 0) {
    throw new Error(
      `Missing coverage records:\n${missing.map((source) => `- ${source}`).join("\n")}`,
    );
  }

  let functionsFound = 0;
  let functionsHit = 0;
  let linesFound = 0;
  let linesHit = 0;
  for (const source of normalizedSources) {
    const record = records.get(source)!;
    if (record.linesFound > 0) {
      assertFileThreshold(
        source,
        "line",
        coverageRatio(record.linesHit, record.linesFound),
        perFileThresholds.lines,
      );
    }
    if (record.functionsFound > 0) {
      assertFileThreshold(
        source,
        "function",
        coverageRatio(record.functionsHit, record.functionsFound),
        perFileThresholds.functions,
      );
    }
    functionsFound += record.functionsFound;
    functionsHit += record.functionsHit;
    linesFound += record.linesFound;
    linesHit += record.linesHit;
  }

  const summary: CoverageSummary = {
    files: normalizedSources.length,
    functions: {
      found: functionsFound,
      hit: functionsHit,
      ratio: coverageRatio(functionsHit, functionsFound),
    },
    lines: {
      found: linesFound,
      hit: linesHit,
      ratio: coverageRatio(linesHit, linesFound),
    },
  };
  assertThreshold("Line", summary.lines.ratio, thresholds.lines);
  assertThreshold("Function", summary.functions.ratio, thresholds.functions);
  return summary;
}

function assertFileThreshold(
  source: string,
  metric: "line" | "function",
  actual: number,
  required: number,
): void {
  if (actual + Number.EPSILON < required) {
    throw new Error(
      `${source} ${metric} coverage ${formatPercentage(actual)} is below ${formatPercentage(required)}.`,
    );
  }
}

function readMetric(lines: readonly string[], name: string, source: string): number {
  const prefix = `${name}:`;
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  if (!line || !/^\d+$/.test(line.slice(prefix.length))) {
    throw new Error(`Invalid or missing ${name} metric for ${source}.`);
  }
  return Number.parseInt(line.slice(prefix.length), 10);
}

function validateRecord(record: CoverageRecord): void {
  if (record.functionsHit > record.functionsFound) {
    throw new Error(`Function hits exceed functions found for ${record.source}.`);
  }
  if (record.linesHit > record.linesFound) {
    throw new Error(`Line hits exceed lines found for ${record.source}.`);
  }
}

function validateThresholds(thresholds: CoverageThresholds): void {
  for (const [name, value] of Object.entries(thresholds)) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`Coverage threshold ${name} must be between 0 and 1.`);
    }
  }
}

function coverageRatio(hit: number, found: number): number {
  if (found === 0) throw new Error("Coverage totals contain no executable entries.");
  return hit / found;
}

function assertThreshold(name: string, actual: number, required: number): void {
  if (actual + Number.EPSILON < required) {
    throw new Error(
      `${name} coverage ${formatPercentage(actual)} is below ${formatPercentage(required)}.`,
    );
  }
}

function normalizeSource(source: string): string {
  const path = isAbsolute(source) ? relative(REPOSITORY_ROOT, source) : source;
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function collectRequiredSources(): string[] {
  const sources = COVERAGE_ROOTS.flatMap((root) =>
    collectTypeScriptFiles(resolve(REPOSITORY_ROOT, root)),
  )
    .map((source) => normalizeSource(source))
    .sort();
  if (sources.length === 0) throw new Error("No production source files were found for coverage.");
  return sources;
}

function collectTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectTypeScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      files.push(path);
    }
  }
  return files;
}

function formatPercentage(ratio: number): string {
  return `${(ratio * 100).toFixed(2)}%`;
}

function main(): void {
  const coveragePath = resolve(REPOSITORY_ROOT, process.argv[2] ?? DEFAULT_COVERAGE_FILE);
  const summary = validateCoverage(readFileSync(coveragePath, "utf8"), collectRequiredSources());
  console.log(
    `Coverage gate passed across ${summary.files} files: ` +
      `${formatPercentage(summary.lines.ratio)} lines (${summary.lines.hit}/${summary.lines.found}) and ` +
      `${formatPercentage(summary.functions.ratio)} functions ` +
      `(${summary.functions.hit}/${summary.functions.found}).`,
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(
      `Coverage check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
