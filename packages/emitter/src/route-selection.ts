import type { Type } from "@typespec/compiler";
import { isSharedRoute, type HttpOperation } from "@typespec/http";
import type { EmitterCtx } from "./ctx.js";
import { $lib } from "./lib.js";
import { getNamespaceFullName } from "./namespace-names.js";
import { isSameEndpointOverload } from "./operation-surface.js";
import { lowerUriTemplate, type RoutePattern } from "./uri-template.js";

export interface RouteHeaderConstraintEmission {
  readonly name: string;
  readonly values: readonly string[];
  readonly kind: "exact" | "media-type";
}

export interface RouteSelectionEmission {
  readonly headers: readonly RouteHeaderConstraintEmission[];
}

interface AnalyzedRoute {
  readonly operation: HttpOperation;
  readonly method: string;
  readonly path: string;
  readonly structure: string;
}

interface RouteConflict {
  readonly kind: "duplicate" | "ambiguous-shared";
  readonly first: AnalyzedRoute;
  readonly second: AnalyzedRoute;
}

interface RouteAnalysis {
  readonly selections: ReadonlyMap<HttpOperation, RouteSelectionEmission>;
  readonly conflicts: readonly RouteConflict[];
}

/** Reports method/path collisions before any generated files are written. */
export function reportRouteConflicts(ctx: EmitterCtx, operations: readonly HttpOperation[]): void {
  for (const conflict of analyzeRoutes(ctx, operations).conflicts) {
    const first = operationLabel(conflict.first.operation);
    const second = operationLabel(conflict.second.operation);
    $lib.reportDiagnostic(ctx.program, {
      code: conflict.kind === "duplicate" ? "duplicate-route" : "ambiguous-shared-route",
      format: {
        first,
        second,
        method: conflict.second.method,
        path: conflict.second.path,
      },
      target: conflict.second.operation.operation,
    });
  }
}

/** Route selectors for collision groups that are proven pairwise disjoint. */
export function getSharedRouteSelections(
  ctx: EmitterCtx,
  operations: readonly HttpOperation[],
): ReadonlyMap<HttpOperation, RouteSelectionEmission> {
  return analyzeRoutes(ctx, operations).selections;
}

function analyzeRoutes(ctx: EmitterCtx, operations: readonly HttpOperation[]): RouteAnalysis {
  const groups = new Map<string, AnalyzedRoute[]>();
  for (const operation of operations) {
    // Same-endpoint overloads are a distinct TypeSpec construct. They are
    // intentionally excluded from ordinary duplicate/shared-route analysis.
    if (isSameEndpointOverload(operation)) {
      continue;
    }

    const lowered = lowerUriTemplate(operation);
    if (!lowered.ok) continue;
    const method = operation.verb.toUpperCase();
    for (const routePattern of lowered.value.routePatterns) {
      const structure = routePatternStructure(routePattern);
      const analyzed = { operation, method, path: lowered.value.path, structure };
      const key = `${method}:${structure}`;
      const group = groups.get(key);
      if (group) group.push(analyzed);
      else groups.set(key, [analyzed]);
    }
  }

  const selections = new Map<HttpOperation, RouteSelectionEmission>();
  const conflicts: RouteConflict[] = [];

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    if (!group.every(({ operation }) => isSharedRoute(ctx.program, operation.operation))) {
      forEachPair(group, (first, second) => conflicts.push({ kind: "duplicate", first, second }));
      continue;
    }

    const groupSelections = new Map(
      group.map(({ operation }) => [operation, routeSelectionForOperation(operation)] as const),
    );
    let hasConflict = false;
    forEachPair(group, (first, second) => {
      const left = groupSelections.get(first.operation);
      const right = groupSelections.get(second.operation);
      if (routeSelectionsAreDisjoint(left, right)) return;
      hasConflict = true;
      conflicts.push({ kind: "ambiguous-shared", first, second });
    });
    if (hasConflict) continue;

    for (const route of group) {
      selections.set(route.operation, groupSelections.get(route.operation)!);
    }
  }

  return { selections, conflicts };
}

function routeSelectionForOperation(operation: HttpOperation): RouteSelectionEmission | undefined {
  const constraints = new Map<string, RouteHeaderConstraintEmission>();
  let requiredContentTypes: readonly string[] | undefined;

  for (const parameter of operation.parameters.parameters) {
    if (parameter.type !== "header" || parameter.param.optional) continue;
    const values = finiteStringValues(parameter.param.type);
    if (!values || values.length === 0) continue;
    const name = parameter.name.toLowerCase();
    if (name === "content-type") {
      requiredContentTypes = values;
      continue;
    }
    constraints.set(name, { name, values, kind: "exact" });
  }

  const body = operation.parameters.body;
  const bodyCanOmitContentType =
    body?.property?.optional === true ||
    (body?.bodyKind === "file" && body.contentTypeProperty.optional);
  const bodyContentTypes =
    body && !bodyCanOmitContentType && body.contentTypes.length > 0 ? body.contentTypes : undefined;
  const contentTypes = bodyContentTypes ?? requiredContentTypes;
  if (contentTypes && contentTypes.length > 0) {
    constraints.set("content-type", {
      name: "content-type",
      values: [...new Set(contentTypes.map(normalizeMediaRange))].sort(),
      kind: "media-type",
    });
  }

  if (constraints.size === 0) return undefined;
  return {
    headers: [...constraints.values()].sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function finiteStringValues(type: Type): readonly string[] | undefined {
  switch (type.kind) {
    case "String":
      return [type.value];
    case "StringTemplate":
      return type.stringValue === undefined ? undefined : [type.stringValue];
    case "Enum": {
      const values = [...type.members.values()].map((member) => member.value ?? member.name);
      return values.every((value): value is string => typeof value === "string")
        ? [...new Set(values)].sort()
        : undefined;
    }
    case "EnumMember": {
      const value = type.value ?? type.name;
      return typeof value === "string" ? [value] : undefined;
    }
    case "Union": {
      const values: string[] = [];
      for (const variant of type.variants.values()) {
        const variantValues = finiteStringValues(variant.type);
        if (!variantValues) return undefined;
        values.push(...variantValues);
      }
      return [...new Set(values)].sort();
    }
    case "UnionVariant":
    case "ModelProperty":
      return finiteStringValues(type.type);
    default:
      return undefined;
  }
}

function routeSelectionsAreDisjoint(
  left: RouteSelectionEmission | undefined,
  right: RouteSelectionEmission | undefined,
): boolean {
  if (!left || !right) return false;
  for (const leftHeader of left.headers) {
    const rightHeader = right.headers.find((header) => header.name === leftHeader.name);
    if (!rightHeader || rightHeader.kind !== leftHeader.kind) continue;
    const overlaps = leftHeader.values.some((leftValue) =>
      rightHeader.values.some((rightValue) =>
        leftHeader.kind === "media-type"
          ? mediaRangesOverlap(leftValue, rightValue)
          : leftValue === rightValue,
      ),
    );
    if (!overlaps) return true;
  }
  return false;
}

function normalizeMediaRange(value: string): string {
  const semicolon = value.indexOf(";");
  return (semicolon === -1 ? value : value.substring(0, semicolon)).trim().toLowerCase();
}

function mediaRangesOverlap(left: string, right: string): boolean {
  const [leftType, leftSubtype] = normalizeMediaRange(left).split("/", 2);
  const [rightType, rightSubtype] = normalizeMediaRange(right).split("/", 2);
  if (!leftType || !leftSubtype || !rightType || !rightSubtype) return true;
  if ((leftType === "*" && leftSubtype === "*") || (rightType === "*" && rightSubtype === "*")) {
    return true;
  }
  if (leftType !== rightType) return false;
  return leftSubtype === "*" || rightSubtype === "*" || leftSubtype === rightSubtype;
}

function routePatternStructure(pattern: RoutePattern): string {
  return JSON.stringify({
    segments: pattern.segments.map((segment) =>
      segment.map((token) =>
        token.kind === "literal"
          ? ["literal", canonicalizeRouteLiteral(token.value)]
          : ["parameter"],
      ),
    ),
    trailingSlash: pattern.trailingSlash,
  });
}

function canonicalizeRouteLiteral(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const byte = percentByte(value, index);
    if (byte === undefined) {
      result += value[index]!;
      continue;
    }
    if (isUnreserved(byte)) {
      result += String.fromCharCode(byte);
      index += 2;
      continue;
    }
    const utf8 = decodeUtf8Escapes(value, index, byte);
    if (utf8) {
      result += utf8.value;
      index = utf8.end - 1;
      continue;
    }
    result += `%${value.slice(index + 1, index + 3).toUpperCase()}`;
    index += 2;
  }
  return result;
}

function percentByte(value: string, index: number): number | undefined {
  if (value[index] !== "%" || index + 2 >= value.length) return undefined;
  const hex = value.slice(index + 1, index + 3);
  return /^[0-9A-Fa-f]{2}$/.test(hex) ? Number.parseInt(hex, 16) : undefined;
}

function isUnreserved(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    (byte >= 0x30 && byte <= 0x39) ||
    byte === 0x2d ||
    byte === 0x2e ||
    byte === 0x5f ||
    byte === 0x7e
  );
}

function decodeUtf8Escapes(
  value: string,
  start: number,
  firstByte: number,
): { readonly value: string; readonly end: number } | undefined {
  const byteLength =
    firstByte >= 0xc2 && firstByte <= 0xdf
      ? 2
      : firstByte >= 0xe0 && firstByte <= 0xef
        ? 3
        : firstByte >= 0xf0 && firstByte <= 0xf4
          ? 4
          : 0;
  if (byteLength === 0) return undefined;

  let encoded = "";
  for (let offset = 0; offset < byteLength; offset += 1) {
    const index = start + offset * 3;
    const byte = percentByte(value, index);
    if (byte === undefined || (offset > 0 && (byte < 0x80 || byte > 0xbf))) return undefined;
    encoded += value.slice(index, index + 3);
  }
  try {
    return { value: decodeURIComponent(encoded), end: start + byteLength * 3 };
  } catch {
    return undefined;
  }
}

function operationLabel(operation: HttpOperation): string {
  const namespace = getNamespaceFullName(operation.operation.namespace);
  const interfaceName = operation.operation.interface?.name;
  return [namespace, interfaceName, operation.operation.name].filter(Boolean).join(".");
}

function forEachPair<T>(items: readonly T[], visit: (first: T, second: T) => void): void {
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      visit(items[left]!, items[right]!);
    }
  }
}
