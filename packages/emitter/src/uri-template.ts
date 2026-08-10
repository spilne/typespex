import type { Type } from "@typespec/compiler";
import type { HttpOperation } from "@typespec/http";
import type { EmitterCtx } from "./ctx.js";
import { $lib } from "./lib.js";

export type RoutePatternToken =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "parameter"; readonly name: string }
  | { readonly kind: "rest"; readonly name: string };

export interface RoutePattern {
  readonly segments: readonly (readonly RoutePatternToken[])[];
  readonly trailingSlash: boolean;
}

export interface LoweredUriTemplate {
  /** Readable path portion of the URI template, without query expansions. */
  readonly path: string;
  /** Concrete matcher routes represented by the path template. */
  readonly routePatterns: readonly RoutePattern[];
  /** Path parameters proven to use the RFC 6570 slash operator. */
  readonly slashExpandedPathNames?: readonly string[];
  /** Path parameters proven to use the RFC 6570 label operator. */
  readonly labelExpandedPathNames?: readonly string[];
  /** Path parameters proven to use the RFC 6570 matrix operator. */
  readonly matrixExpandedPathNames?: readonly string[];
}

export type UriTemplateLowering =
  | { readonly ok: true; readonly value: LoweredUriTemplate }
  | { readonly ok: false; readonly reason: string };

const URI_TEMPLATE_OPERATORS = new Set(["+", "#", ".", "/", ";", "?", "&"]);
const RESERVED_PARAMETER_SEPARATORS = new Set(":[]@!$&'()*+,;=");

/** Reports every URI template that cannot be lowered without changing its meaning. */
export function reportUnsupportedUriTemplates(
  ctx: EmitterCtx,
  operations: readonly HttpOperation[],
): void {
  for (const operation of operations) {
    const result = lowerUriTemplate(operation);
    if (result.ok) continue;
    $lib.reportDiagnostic(ctx.program, {
      code: "unsupported-uri-template",
      format: {
        operation: operation.operation.name,
        template: operation.uriTemplate,
        reason: result.reason,
      },
      target: operation.operation,
    });
  }
}

/** Strictly lowers the TypeSpec HTTP operation's resolved RFC 6570 URI template. */
export function lowerUriTemplate(operation: HttpOperation): UriTemplateLowering {
  const pathNames = new Set<string>();
  const scalarPathNames = new Set<string>();
  const scalarArrayPathNames = new Set<string>();
  const optionalPathNames = new Set<string>();
  const queryNames = new Set<string>();
  for (const parameter of operation.parameters.parameters) {
    const names =
      parameter.type === "path" ? pathNames : parameter.type === "query" ? queryNames : undefined;
    if (!names) continue;
    if (names.has(parameter.name)) {
      return failure(
        `multiple ${parameter.type} parameters use wire name ${JSON.stringify(parameter.name)}`,
      );
    }
    names.add(parameter.name);
    if (parameter.type === "path" && isScalarWireType(parameter.param.type)) {
      scalarPathNames.add(parameter.name);
    }
    if (parameter.type === "path" && isScalarArrayWireType(parameter.param.type)) {
      scalarArrayPathNames.add(parameter.name);
    }
    if (parameter.type === "path" && parameter.param.optional) {
      optionalPathNames.add(parameter.name);
    }
  }
  const slashExpandedPathNames = new Set<string>();
  const labelExpandedPathNames = new Set<string>();
  const matrixExpandedPathNames = new Set<string>();
  const lowered = lowerUriTemplateTextInternal(
    operation.uriTemplate,
    pathNames,
    queryNames,
    scalarPathNames,
    optionalPathNames,
    scalarArrayPathNames,
    slashExpandedPathNames,
    labelExpandedPathNames,
    matrixExpandedPathNames,
  );
  if (!lowered.ok) return lowered;
  return {
    ok: true,
    value: {
      ...lowered.value,
      slashExpandedPathNames: [...slashExpandedPathNames],
      labelExpandedPathNames: [...labelExpandedPathNames],
      matrixExpandedPathNames: [...matrixExpandedPathNames],
    },
  };
}

/** Exposed for focused parser tests without constructing compiler HTTP types. */
export function lowerUriTemplateText(
  template: string,
  pathNames: ReadonlySet<string>,
  queryNames: ReadonlySet<string>,
  scalarPathNames: ReadonlySet<string> = pathNames,
  optionalPathNames: ReadonlySet<string> = new Set(),
  scalarArrayPathNames: ReadonlySet<string> = new Set(),
): UriTemplateLowering {
  return lowerUriTemplateTextInternal(
    template,
    pathNames,
    queryNames,
    scalarPathNames,
    optionalPathNames,
    scalarArrayPathNames,
  );
}

function lowerUriTemplateTextInternal(
  template: string,
  pathNames: ReadonlySet<string>,
  queryNames: ReadonlySet<string>,
  scalarPathNames: ReadonlySet<string>,
  optionalPathNames: ReadonlySet<string>,
  scalarArrayPathNames: ReadonlySet<string>,
  slashExpandedPathNames?: Set<string>,
  labelExpandedPathNames?: Set<string>,
  matrixExpandedPathNames?: Set<string>,
): UriTemplateLowering {
  if (!template.startsWith("/")) {
    return failure("the template must begin with '/'");
  }

  const segments: RoutePatternToken[][] = [];
  let segment: RoutePatternToken[] = [];
  let leadingSlashSeen = false;
  let queryStarted = false;
  let pathEnd = template.length;
  const seenPathVariables = new Set<string>();
  const seenQueryVariables = new Set<string>();
  let optionalSlashParameter: string | undefined;
  let explodedSlashParameter: string | undefined;

  const appendLiteral = (literal: string): UriTemplateLowering | undefined => {
    if (literal.includes("?") || literal.includes("#")) {
      return failure("literal query or fragment syntax is not supported");
    }
    for (const character of literal) {
      if (character === "/") {
        if (!leadingSlashSeen) {
          leadingSlashSeen = true;
          continue;
        }
        if (segment.length === 0) {
          return failure("empty path segments are not supported");
        }
        segments.push(segment);
        segment = [];
        continue;
      }
      if (!leadingSlashSeen) {
        return failure("path material appears before the leading '/'");
      }
      appendLiteralToken(segment, character);
    }
    return undefined;
  };

  let cursor = 0;
  while (cursor < template.length) {
    const character = template[cursor]!;
    if (character === "}") {
      return failure(`unexpected '}' at offset ${cursor}`);
    }
    if (character !== "{") {
      let end = cursor + 1;
      while (end < template.length && template[end] !== "{" && template[end] !== "}") end += 1;
      const literal = template.slice(cursor, end);
      if (queryStarted) {
        return failure("path material appears after a query expansion");
      }
      if (optionalSlashParameter !== undefined) {
        return failure("path material appears after an optional slash expansion");
      }
      if (explodedSlashParameter !== undefined) {
        return failure("path material appears after an exploded slash expansion");
      }
      const literalFailure = appendLiteral(literal);
      if (literalFailure) return literalFailure;
      cursor = end;
      continue;
    }

    const closing = findExpressionEnd(template, cursor);
    if (!closing.ok) return closing;
    const expression = template.slice(cursor + 1, closing.index);
    if (expression.length === 0) return failure("empty URI-template expressions are invalid");

    const operator = URI_TEMPLATE_OPERATORS.has(expression[0]!) ? expression[0]! : undefined;
    const variables = operator ? expression.slice(1) : expression;
    if (operator === "?" || operator === "&") {
      if (!queryStarted) {
        if (operator !== "?") {
          return failure("a query continuation expansion cannot appear before a query expansion");
        }
        queryStarted = true;
        pathEnd = cursor;
      } else if (operator === "?") {
        return failure("a second query expansion cannot start after query expansion has begun");
      }

      const queryFailure = validateExpressionVariables(
        variables,
        queryNames,
        seenQueryVariables,
        "query",
        true,
      );
      if (queryFailure) return queryFailure;
      cursor = closing.index + 1;
      continue;
    }

    if (queryStarted) {
      return failure("path material appears after a query expansion");
    }
    if (optionalSlashParameter !== undefined) {
      return failure("path material appears after an optional slash expansion");
    }
    if (explodedSlashParameter !== undefined) {
      return failure("path material appears after an exploded slash expansion");
    }
    if (operator === "/") {
      const exploded = variables.endsWith("*");
      const slashVariables = exploded ? variables.slice(0, -1) : variables;
      const parsed = parseExpressionVariables(
        slashVariables,
        pathNames,
        seenPathVariables,
        "path",
        false,
      );
      if (!parsed.ok) return parsed;
      if (parsed.names.length !== 1) {
        return failure("slash expansions must contain exactly one path variable");
      }
      const name = parsed.names[0]!;
      const scalarArray = scalarArrayPathNames.has(name);
      if (!scalarPathNames.has(name) && !scalarArray) {
        return failure(
          `slash-expanded path variable ${JSON.stringify(name)} must have a scalar or scalar-array wire shape`,
        );
      }
      if (segment.length === 0) {
        return failure("a slash expansion must follow a non-empty path segment");
      }
      const optional = optionalPathNames.has(name);
      if (scalarArray && optional) {
        return failure(
          `slash-expanded scalar-array path variable ${JSON.stringify(name)} must be required`,
        );
      }
      if (optional && exploded) {
        return failure("exploded optional slash expansions are not supported");
      }
      slashExpandedPathNames?.add(name);
      if (scalarArray && exploded) {
        segments.push(segment);
        segment = [{ kind: "rest", name }];
        explodedSlashParameter = name;
        cursor = closing.index + 1;
        continue;
      }
      if (!optional) {
        segments.push(segment);
        segment = [{ kind: "parameter", name }];
        cursor = closing.index + 1;
        continue;
      }
      optionalSlashParameter = name;
      cursor = closing.index + 1;
      continue;
    }
    if (operator === ".") {
      const exploded = variables.endsWith("*");
      const labelVariables = exploded ? variables.slice(0, -1) : variables;
      const parsed = parseExpressionVariables(
        labelVariables,
        pathNames,
        seenPathVariables,
        "path",
        false,
      );
      if (!parsed.ok) return parsed;
      if (parsed.names.length !== 1) {
        return failure("label expansions must contain exactly one path variable");
      }
      const name = parsed.names[0]!;
      const scalarArray = scalarArrayPathNames.has(name);
      if (optionalPathNames.has(name)) {
        return failure(`label-expanded path variable ${JSON.stringify(name)} must be required`);
      }
      if (!scalarPathNames.has(name) && !scalarArray) {
        return failure(
          `label-expanded path variable ${JSON.stringify(name)} must have a scalar or scalar-array wire shape`,
        );
      }
      labelExpandedPathNames?.add(name);
      appendLiteralToken(segment, ".");
      segment.push({ kind: "parameter", name });
      cursor = closing.index + 1;
      continue;
    }
    if (operator === ";") {
      const exploded = variables.endsWith("*");
      const matrixVariables = exploded ? variables.slice(0, -1) : variables;
      const parsed = parseExpressionVariables(
        matrixVariables,
        pathNames,
        seenPathVariables,
        "path",
        false,
      );
      if (!parsed.ok) return parsed;
      if (parsed.names.length !== 1) {
        return failure("matrix expansions must contain exactly one path variable");
      }
      const name = parsed.names[0]!;
      if (matrixVariables !== name) {
        return failure("percent-encoded matrix variable names are not supported");
      }
      const scalarArray = scalarArrayPathNames.has(name);
      if (optionalPathNames.has(name)) {
        return failure(`matrix-expanded path variable ${JSON.stringify(name)} must be required`);
      }
      if (!scalarPathNames.has(name) && !scalarArray) {
        return failure(
          `matrix-expanded path variable ${JSON.stringify(name)} must have a scalar or scalar-array wire shape`,
        );
      }
      matrixExpandedPathNames?.add(name);
      appendLiteralToken(segment, `;${matrixVariables}=`);
      segment.push({ kind: "parameter", name });
      cursor = closing.index + 1;
      continue;
    }
    if (operator !== undefined) {
      return failure(`URI-template operator ${JSON.stringify(operator)} is not supported in paths`);
    }

    const exploded = variables.endsWith("*");
    const simpleVariables = exploded ? variables.slice(0, -1) : variables;
    const parsed = parseExpressionVariables(
      simpleVariables,
      pathNames,
      seenPathVariables,
      "path",
      false,
    );
    if (!parsed.ok) return parsed;
    if (exploded) {
      if (parsed.names.length !== 1) {
        return failure("exploded simple expansions must contain exactly one path variable");
      }
      const name = parsed.names[0]!;
      if (optionalPathNames.has(name)) {
        return failure(`exploded simple path variable ${JSON.stringify(name)} must be required`);
      }
      if (!scalarPathNames.has(name) && !scalarArrayPathNames.has(name)) {
        return failure(
          `exploded simple path variable ${JSON.stringify(name)} must have a scalar or scalar-array wire shape`,
        );
      }
    }
    for (let index = 0; index < parsed.names.length; index += 1) {
      if (index > 0) appendLiteralToken(segment, ",");
      segment.push({ kind: "parameter", name: parsed.names[index]! });
    }
    cursor = closing.index + 1;
  }

  if (!leadingSlashSeen) return failure("the template must contain an absolute path");
  const path = template.slice(0, pathEnd);
  const trailingSlash = path.endsWith("/");
  if (segment.length > 0) {
    segments.push(segment);
  } else if (!trailingSlash) {
    return failure("the path ends in an empty segment");
  }

  for (const candidate of segments) {
    const ambiguity = ambiguousSegmentReason(candidate, scalarPathNames);
    if (ambiguity) return failure(ambiguity);
  }
  for (const pathName of pathNames) {
    if (!seenPathVariables.has(pathName)) {
      return failure(`path parameter ${JSON.stringify(pathName)} does not appear in the template`);
    }
  }
  for (const queryName of queryNames) {
    if (!seenQueryVariables.has(queryName)) {
      return failure(
        `query parameter ${JSON.stringify(queryName)} does not appear in the template`,
      );
    }
  }

  return {
    ok: true,
    value: {
      path,
      routePatterns:
        optionalSlashParameter === undefined
          ? [{ segments, trailingSlash }]
          : [
              { segments, trailingSlash: false },
              {
                segments: [...segments, [{ kind: "parameter", name: optionalSlashParameter }]],
                trailingSlash: false,
              },
            ],
    },
  };
}

function findExpressionEnd(
  template: string,
  opening: number,
): { readonly ok: true; readonly index: number } | { readonly ok: false; readonly reason: string } {
  for (let index = opening + 1; index < template.length; index += 1) {
    if (template[index] === "{") {
      return failure(`nested '{' at offset ${index}`);
    }
    if (template[index] === "}") return { ok: true, index };
  }
  return failure(`unclosed '{' at offset ${opening}`);
}

function validateExpressionVariables(
  expression: string,
  expected: ReadonlySet<string>,
  seen: Set<string>,
  location: "path" | "query",
  allowModifiers: boolean,
): UriTemplateLowering | undefined {
  const result = parseExpressionVariables(expression, expected, seen, location, allowModifiers);
  return result.ok ? undefined : result;
}

function parseExpressionVariables(
  expression: string,
  expected: ReadonlySet<string>,
  seen: Set<string>,
  location: "path" | "query",
  allowModifiers: boolean,
):
  | { readonly ok: true; readonly names: readonly string[] }
  | { readonly ok: false; readonly reason: string } {
  if (expression.length === 0) return failure("URI-template expression has no variables");
  const names: string[] = [];
  for (const rawSpec of expression.split(",")) {
    if (rawSpec.length === 0) return failure("URI-template expression contains an empty variable");
    const parsed = parseVariableSpec(rawSpec, allowModifiers, location);
    if (!parsed.ok) return parsed;
    const name = parsed.name;
    if (!expected.has(name)) {
      return failure(`unknown ${location} variable ${JSON.stringify(name)}`);
    }
    if (seen.has(name)) {
      return failure(`variable ${JSON.stringify(name)} appears more than once`);
    }
    seen.add(name);
    names.push(name);
  }
  return { ok: true, names };
}

function parseVariableSpec(
  rawSpec: string,
  allowModifiers: boolean,
  location: "path" | "query",
): { readonly ok: true; readonly name: string } | { readonly ok: false; readonly reason: string } {
  let rawName = rawSpec;
  let modifier: string | undefined;
  if (rawSpec.endsWith("*")) {
    rawName = rawSpec.slice(0, -1);
    modifier = "*";
  } else {
    const colon = rawSpec.lastIndexOf(":");
    if (colon >= 0) {
      const prefix = rawSpec.slice(colon + 1);
      if (!/^[1-9][0-9]{0,3}$/.test(prefix)) {
        return failure(`malformed prefix modifier in ${JSON.stringify(rawSpec)}`);
      }
      rawName = rawSpec.slice(0, colon);
      modifier = `:${prefix}`;
    }
  }
  if (rawName.includes("*") || rawName.includes(":")) {
    return failure(`malformed variable specification ${JSON.stringify(rawSpec)}`);
  }
  if (modifier && !allowModifiers) {
    return failure(
      `modifier ${JSON.stringify(modifier)} on ${location} variable ${JSON.stringify(rawName)} is not supported`,
    );
  }
  if (rawName.length === 0) return failure("URI-template variable name is empty");

  for (let index = 0; index < rawName.length; index += 1) {
    if (rawName[index] !== "%") continue;
    const escape = rawName.slice(index + 1, index + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(escape)) {
      return failure(`malformed percent escape in variable name ${JSON.stringify(rawName)}`);
    }
    index += 2;
  }

  try {
    return { ok: true, name: decodeURIComponent(rawName) };
  } catch {
    return failure(`malformed percent escape in variable name ${JSON.stringify(rawName)}`);
  }
}

function ambiguousSegmentReason(
  tokens: readonly RoutePatternToken[],
  scalarPathNames: ReadonlySet<string>,
): string | undefined {
  let previousParameter = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    const parameter = tokens[index]!;
    if (parameter.kind !== "parameter") continue;
    if (previousParameter >= 0) {
      const separator = tokens
        .slice(previousParameter + 1, index)
        .map((token) => (token.kind === "literal" ? token.value : ""))
        .join("");
      if (separator.length === 0) {
        return "adjacent path variables cannot be captured unambiguously";
      }
      if (![...separator].some((character) => RESERVED_PARAMETER_SEPARATORS.has(character))) {
        return `path variables separated by unreserved literal ${JSON.stringify(separator)} cannot be captured unambiguously`;
      }
      if (/^,+$/.test(separator)) {
        const previous = tokens[previousParameter]!;
        const collectionName =
          previous.kind === "parameter" && !scalarPathNames.has(previous.name)
            ? previous.name
            : !scalarPathNames.has(parameter.name)
              ? parameter.name
              : undefined;
        if (collectionName !== undefined) {
          return `path variables separated only by commas require scalar variables, but ${JSON.stringify(collectionName)} has a collection shape`;
        }
      }
    }
    previousParameter = index;
  }
  return undefined;
}

function appendLiteralToken(tokens: RoutePatternToken[], value: string): void {
  const previous = tokens[tokens.length - 1];
  if (previous?.kind === "literal") {
    tokens[tokens.length - 1] = { kind: "literal", value: previous.value + value };
  } else {
    tokens.push({ kind: "literal", value });
  }
}

function isScalarWireType(type: Type): boolean {
  switch (type.kind) {
    case "Scalar":
    case "Enum":
    case "EnumMember":
    case "String":
    case "StringTemplate":
    case "Number":
    case "Boolean":
    case "Intrinsic":
      return true;
    case "Union":
      return [...type.variants.values()].every((variant) => isScalarWireType(variant.type));
    case "UnionVariant":
    case "ModelProperty":
      return isScalarWireType(type.type);
    default:
      return false;
  }
}

function isScalarArrayWireType(type: Type): boolean {
  return (
    type.kind === "Model" &&
    type.indexer?.key.name === "integer" &&
    isScalarWireType(type.indexer.value)
  );
}

function failure(reason: string): { readonly ok: false; readonly reason: string } {
  return { ok: false, reason };
}
