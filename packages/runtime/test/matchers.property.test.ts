import { describe, expect, test } from "bun:test";
import { createRadixMatcher } from "../src/match-radix.js";
import { createRegexMatcher } from "../src/match-regex.js";
import type { RouteMatch, RouteMatcher, RouteMatcherInput, RoutePattern } from "../src/matcher.js";

const BASE_SEED = 0x5eedc0de;
const GENERATED_SCENARIOS = 96;
const RANDOM_PROBES_PER_SCENARIO = 24;
const REPLAY_SEED_VARIABLE = "TYPESPEX_MATCHER_SEED";

interface RequestInput {
  readonly method: string;
  readonly pathname: string;
  readonly headers?: Readonly<Record<string, string>>;
}

interface ExpectedMatch {
  readonly route: string;
  readonly pathParams: Readonly<Record<string, string>>;
}

interface ExpectedCase extends RequestInput {
  readonly label: string;
  readonly expected: ExpectedMatch | null;
}

interface GeneratedScenario {
  readonly routes: readonly RouteMatcherInput<string>[];
  readonly expectedCases: readonly ExpectedCase[];
  readonly probes: readonly RequestInput[];
}

interface MatcherVariant {
  readonly name: string;
  readonly matcher: RouteMatcher<string>;
}

type Random = () => number;

function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function scenarioSeeds(): readonly number[] {
  const replayValue = process.env[REPLAY_SEED_VARIABLE];
  if (replayValue !== undefined) {
    const seed = Number(replayValue);
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      throw new Error(`${REPLAY_SEED_VARIABLE} must be an unsigned 32-bit integer.`);
    }
    return [seed];
  }
  return Array.from(
    { length: GENERATED_SCENARIOS },
    (_, index) => (BASE_SEED + Math.imul(index, 0x9e3779b1)) >>> 0,
  );
}

function randomInteger(random: Random, maximum: number): number {
  return Math.floor(random() * maximum);
}

function pick<T>(random: Random, values: readonly T[]): T {
  return values[randomInteger(random, values.length)]!;
}

function randomWord(random: Random, minimumLength = 3, maximumLength = 9): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const length = minimumLength + randomInteger(random, maximumLength - minimumLength + 1);
  let result = "";
  for (let index = 0; index < length; index++) {
    result += alphabet[randomInteger(random, alphabet.length)];
  }
  return result;
}

function shuffle<T>(values: readonly T[], random: Random): T[] {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = randomInteger(random, index + 1);
    [shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!];
  }
  if (shuffled.length > 1 && shuffled.every((value, index) => value === values[index])) {
    [shuffled[0], shuffled[1]] = [shuffled[1]!, shuffled[0]!];
  }
  return shuffled;
}

function literalPattern(segments: readonly string[], trailingSlash: boolean): RoutePattern {
  return {
    segments: segments.map((value) => [{ kind: "literal", value }]),
    trailingSlash,
  };
}

function encodeFirstCharacter(value: string): string {
  const first = value.codePointAt(0)!;
  const character = String.fromCodePoint(first);
  const encoded = [...new TextEncoder().encode(character)]
    .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
    .join("");
  return encoded + value.slice(character.length);
}

function plainMatch(match: RouteMatch<string> | null): ExpectedMatch | null {
  return match
    ? {
        route: match.route,
        pathParams: { ...match.pathParams },
      }
    : null;
}

function execute(matcher: RouteMatcher<string>, request: RequestInput): ExpectedMatch | null {
  const headers = request.headers ? new Headers(request.headers) : undefined;
  return plainMatch(matcher.match(request.method, request.pathname, headers));
}

function matcherVariants(
  routes: readonly RouteMatcherInput<string>[],
  seed: number,
): readonly MatcherVariant[] {
  const permuted = shuffle(routes, seededRandom(seed ^ 0xa5a5a5a5));
  return [
    { name: "regex/original", matcher: createRegexMatcher(routes) },
    { name: "radix/original", matcher: createRadixMatcher(routes) },
    { name: "regex/permuted", matcher: createRegexMatcher(permuted) },
    { name: "radix/permuted", matcher: createRadixMatcher(permuted) },
  ];
}

function expectResult(
  seed: number,
  label: string,
  implementation: string,
  actual: ExpectedMatch | null,
  expected: ExpectedMatch | null,
): void {
  expect({ seed, label, implementation, result: actual }).toEqual({
    seed,
    label,
    implementation,
    result: expected,
  });
}

function generateScenario(seed: number): GeneratedScenario {
  const random = seededRandom(seed);
  const method = pick(random, ["GET", "POST", "DELETE"]);
  const wrongMethod = method === "GET" ? "PATCH" : "GET";
  const root = `root-${randomWord(random)}`;
  const staticLeaf = pick(random, [
    `item-${randomWord(random)}`,
    `café-${randomWord(random)}`,
    `🐱-${randomWord(random)}`,
  ]);
  const prefix = `pre-${randomWord(random)}-`;
  const suffix = pick(random, [".json", ":tail", "-end"]);
  const parameterValue = pick(random, [
    randomWord(random),
    "v1.2-beta",
    "hello%20world",
    "a%2Fb",
    "caf%C3%A9",
    "🐱",
    "%ZZ",
  ]);
  const mixedValue = pick(random, [
    "",
    randomWord(random),
    "a%2Fb%20c",
    "caf%C3%A9",
    "🐱",
    "%61lpha",
  ]);
  const leftMode = `left-${randomWord(random)}`;
  const rightMode = `right-${randomWord(random)}`;
  const restPrefix = `rest-${randomWord(random)}`;

  const mixedPattern: RoutePattern = {
    segments: [
      [{ kind: "literal", value: root }],
      [
        { kind: "literal", value: prefix },
        { kind: "parameter", name: "embedded" },
        { kind: "literal", value: suffix },
      ],
    ],
    trailingSlash: false,
  };

  const routes: RouteMatcherInput<string>[] = [
    { method, path: `/${root}/${staticLeaf}`, route: "static" },
    { method, path: `/${root}/:value`, route: "parameter" },
    {
      method,
      path: `/${root}/${prefix}{embedded}${suffix}`,
      routePattern: mixedPattern,
      route: "mixed",
    },
    { method, path: `/${root}/fixed/:tail`, route: "left-static" },
    { method, path: `/${root}/:head/fixed`, route: "right-static" },
    {
      method,
      path: `/${root}/${restPrefix}{/parts*}`,
      routePattern: {
        segments: [
          [{ kind: "literal", value: root }],
          [{ kind: "literal", value: restPrefix }],
          [{ kind: "rest", name: "parts" }],
        ],
        trailingSlash: false,
      },
      route: "rest",
    },
    { method, path: `/${root}/trail`, route: "without-trailing-slash" },
    {
      method,
      path: `/${root}/trail/`,
      routePattern: literalPattern([root, "trail"], true),
      route: "with-trailing-slash",
    },
    {
      method,
      path: `/${root}/shared/:leftId`,
      selection: { headers: [{ name: "x-mode", values: [leftMode] }] },
      route: "shared-left",
    },
    {
      method,
      path: `/${root}/shared/:rightId`,
      selection: { headers: [{ name: "X-Mode", values: [rightMode] }] },
      route: "shared-right",
    },
    {
      method,
      path: `/${root}/documents`,
      selection: {
        headers: [{ name: "content-type", values: ["application/*"], kind: "media-type" }],
      },
      route: "application-document",
    },
    {
      method,
      path: `/${root}/documents`,
      selection: {
        headers: [{ name: "content-type", values: ["text/plain"], kind: "media-type" }],
      },
      route: "text-document",
    },
  ];

  const expectedCases: ExpectedCase[] = [
    {
      label: "canonical static literal",
      method,
      pathname: `/${root}/${encodeURIComponent(staticLeaf)}`,
      expected: { route: "static", pathParams: {} },
    },
    {
      label: "encoded first character of static literal",
      method,
      pathname: `/${encodeFirstCharacter(root)}/${staticLeaf}`,
      expected: { route: "static", pathParams: {} },
    },
    {
      label: "whole-segment parameter preserves raw spelling",
      method,
      pathname: `/${root}/${parameterValue}`,
      expected: { route: "parameter", pathParams: { value: parameterValue } },
    },
    {
      label: "embedded parameter preserves raw spelling",
      method,
      pathname: `/${root}/${prefix}${mixedValue}${suffix}`,
      expected: { route: "mixed", pathParams: { embedded: mixedValue } },
    },
    {
      label: "embedded parameter survives encoded literal boundary",
      method,
      pathname: `/${root}/${encodeFirstCharacter(prefix)}${mixedValue}${suffix}`,
      expected: { route: "mixed", pathParams: { embedded: mixedValue } },
    },
    {
      label: "earlier static segment wins",
      method,
      pathname: `/${root}/fixed/fixed`,
      expected: { route: "left-static", pathParams: { tail: "fixed" } },
    },
    {
      label: "later static segment backtracks from parameter",
      method,
      pathname: `/${root}/other/fixed`,
      expected: { route: "right-static", pathParams: { head: "other" } },
    },
    {
      label: "terminal rest preserves raw multi-segment spelling",
      method,
      pathname: `/${root}/${restPrefix}/${parameterValue}/a%2Fb`,
      expected: {
        route: "rest",
        pathParams: { parts: `${parameterValue}/a%2Fb` },
      },
    },
    {
      label: "terminal rest does not consume zero segments",
      method,
      pathname: `/${root}/${restPrefix}`,
      expected: { route: "parameter", pathParams: { value: restPrefix } },
    },
    {
      label: "route without trailing slash",
      method,
      pathname: `/${root}/trail`,
      expected: { route: "without-trailing-slash", pathParams: {} },
    },
    {
      label: "route with trailing slash",
      method,
      pathname: `/${root}/trail/`,
      expected: { route: "with-trailing-slash", pathParams: {} },
    },
    {
      label: "first header-selected structural variant",
      method,
      pathname: `/${root}/shared/item`,
      headers: { "X-Mode": leftMode },
      expected: { route: "shared-left", pathParams: { leftId: "item" } },
    },
    {
      label: "second header-selected structural variant",
      method,
      pathname: `/${root}/shared/item`,
      headers: { "x-mode": rightMode },
      expected: { route: "shared-right", pathParams: { rightId: "item" } },
    },
    {
      label: "shared route without selector",
      method,
      pathname: `/${root}/shared/item`,
      expected: null,
    },
    {
      label: "media-type wildcard selection",
      method,
      pathname: `/${root}/documents`,
      headers: { "content-type": "Application/JSON; charset=utf-8" },
      expected: { route: "application-document", pathParams: {} },
    },
    {
      label: "media-type exact selection",
      method,
      pathname: `/${root}/documents`,
      headers: { "content-type": "text/plain" },
      expected: { route: "text-document", pathParams: {} },
    },
    {
      label: "wrong method does not match",
      method: wrongMethod,
      pathname: `/${root}/${staticLeaf}`,
      expected: null,
    },
    {
      label: "unregistered trailing slash does not match",
      method,
      pathname: `/${root}/${staticLeaf}/`,
      expected: null,
    },
  ];

  const probeSegments = [
    root,
    staticLeaf,
    `${prefix}${mixedValue}${suffix}`,
    parameterValue,
    "fixed",
    "trail",
    "shared",
    "documents",
    restPrefix,
    "item",
    `missing-${randomWord(random)}`,
  ];
  const probes = Array.from({ length: RANDOM_PROBES_PER_SCENARIO }, (): RequestInput => {
    const segmentCount = 1 + randomInteger(random, 4);
    const firstSegment = random() < 0.85 ? root : pick(random, probeSegments);
    const segments = [
      firstSegment,
      ...Array.from({ length: segmentCount - 1 }, () => pick(random, probeSegments)),
    ];
    let pathname = `/${segments.join("/")}`;
    if (random() < 0.15) pathname += "/";
    if (random() < 0.08) pathname = pathname.substring(1);
    if (random() < 0.08 && pathname.startsWith("/")) pathname = pathname.replace("/", "//");

    const headerKind = randomInteger(random, 6);
    const headers =
      headerKind === 0
        ? { "x-mode": leftMode }
        : headerKind === 1
          ? { "x-mode": rightMode }
          : headerKind === 2
            ? { "content-type": "application/json; charset=utf-8" }
            : headerKind === 3
              ? { "content-type": "text/plain" }
              : undefined;
    return {
      method: pick(random, [method, method, method, wrongMethod, method.toLowerCase()]),
      pathname,
      headers,
    };
  });

  return { routes, expectedCases, probes };
}

describe("route matcher generated properties", () => {
  test("matches a seeded corpus with independently known results", () => {
    for (const seed of scenarioSeeds()) {
      const scenario = generateScenario(seed);
      for (const variant of matcherVariants(scenario.routes, seed)) {
        for (const request of scenario.expectedCases) {
          expectResult(
            seed,
            request.label,
            variant.name,
            execute(variant.matcher, request),
            request.expected,
          );
        }
      }
    }
  });

  test("keeps implementations and registration order equivalent for seeded probes", () => {
    for (const seed of scenarioSeeds()) {
      const scenario = generateScenario(seed);
      const variants = matcherVariants(scenario.routes, seed);
      for (let probeIndex = 0; probeIndex < scenario.probes.length; probeIndex++) {
        const request = scenario.probes[probeIndex]!;
        const expected = execute(variants[0]!.matcher, request);
        for (const variant of variants.slice(1)) {
          expectResult(
            seed,
            `random probe ${probeIndex}: ${request.method} ${request.pathname}`,
            variant.name,
            execute(variant.matcher, request),
            expected,
          );
        }
      }
    }
  });
});
