import type { JsonWirePlan } from "@typespex/compiler-core/unstable";
import { isSchemaRecord } from "./schema-utils.js";

export function schemasDefinitelyDisjoint(success: JsonWirePlan, error: JsonWirePlan): boolean {
  return schemaNodesDefinitelyDisjoint(
    success.schema,
    success.schema,
    error.schema,
    error.schema,
    new Set(),
  );
}

function schemaNodesDefinitelyDisjoint(
  left: unknown,
  leftDocument: unknown,
  right: unknown,
  rightDocument: unknown,
  seen: Set<string>,
): boolean {
  if (left === false || right === false) return true;
  if (left === true || right === true) return false;
  if (!isSchemaRecord(left) || !isSchemaRecord(right)) return false;
  const resolvedLeft = resolveLocalSchemaRef(left, leftDocument);
  const resolvedRight = resolveLocalSchemaRef(right, rightDocument);
  if (resolvedLeft !== left || resolvedRight !== right) {
    const key = `${schemaIdentity(resolvedLeft)}|${schemaIdentity(resolvedRight)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return schemaNodesDefinitelyDisjoint(
      resolvedLeft,
      leftDocument,
      resolvedRight,
      rightDocument,
      seen,
    );
  }

  const leftAlternatives = Array.isArray(left.anyOf) ? left.anyOf : [left];
  const rightAlternatives = Array.isArray(right.anyOf) ? right.anyOf : [right];
  if (leftAlternatives.length > 1 || rightAlternatives.length > 1) {
    return leftAlternatives.every((leftAlternative) =>
      rightAlternatives.every((rightAlternative) =>
        schemaNodesDefinitelyDisjoint(
          leftAlternative,
          leftDocument,
          rightAlternative,
          rightDocument,
          new Set(seen),
        ),
      ),
    );
  }

  if ("const" in left || "const" in right) {
    if ("const" in left && "const" in right) return !Object.is(left.const, right.const);
    const literal = "const" in left ? left.const : right.const;
    const other = "const" in left ? right : left;
    const otherDocument = "const" in left ? rightDocument : leftDocument;
    return schemaDefinitelyRejectsLiteral(other, otherDocument, literal, new Set(seen));
  }
  if (Array.isArray(left.enum) || Array.isArray(right.enum)) {
    if (Array.isArray(left.enum) && Array.isArray(right.enum)) {
      const rightValues = right.enum as unknown[];
      return left.enum.every(
        (value) => !rightValues.some((candidate) => Object.is(value, candidate)),
      );
    }
    const values = (Array.isArray(left.enum) ? left.enum : right.enum) as unknown[];
    const other = Array.isArray(left.enum) ? right : left;
    const otherDocument = Array.isArray(left.enum) ? rightDocument : leftDocument;
    return values.every((value) =>
      schemaDefinitelyRejectsLiteral(other, otherDocument, value, new Set(seen)),
    );
  }
  const leftTypes = schemaTypes(left);
  const rightTypes = schemaTypes(right);
  if (leftTypes && rightTypes && typeSetsDefinitelyDisjoint(leftTypes, rightTypes)) return true;
  const commonTypes = commonSchemaTypes(leftTypes, rightTypes);
  if (commonTypes.includes("object") || (left.properties && right.properties)) {
    return objectSchemasDefinitelyDisjoint(left, leftDocument, right, rightDocument, seen);
  }
  if (commonTypes.includes("number") || commonTypes.includes("integer")) {
    return numericSchemasDefinitelyDisjoint(left, right);
  }
  if (commonTypes.includes("string")) {
    return stringRangesDefinitelyDisjoint(left, right);
  }
  if (commonTypes.includes("array")) {
    const leftMinimum = numberKeyword(left.minItems, 0);
    const rightMinimum = numberKeyword(right.minItems, 0);
    const leftMaximum = numberKeyword(left.maxItems, Number.POSITIVE_INFINITY);
    const rightMaximum = numberKeyword(right.maxItems, Number.POSITIVE_INFINITY);
    if (Math.max(leftMinimum, rightMinimum) > Math.min(leftMaximum, rightMaximum)) return true;
    return (
      Math.max(leftMinimum, rightMinimum) > 0 &&
      schemaNodesDefinitelyDisjoint(
        left.items ?? true,
        leftDocument,
        right.items ?? true,
        rightDocument,
        seen,
      )
    );
  }
  return false;
}

function objectSchemasDefinitelyDisjoint(
  left: Record<string, unknown>,
  leftDocument: unknown,
  right: Record<string, unknown>,
  rightDocument: unknown,
  seen: Set<string>,
): boolean {
  const leftProperties = isSchemaRecord(left.properties) ? left.properties : {};
  const rightProperties = isSchemaRecord(right.properties) ? right.properties : {};
  const leftRequired = new Set(Array.isArray(left.required) ? left.required.filter(isString) : []);
  const rightRequired = new Set(
    Array.isArray(right.required) ? right.required.filter(isString) : [],
  );
  if (
    left.additionalProperties === false &&
    [...rightRequired].some((property) => !(property in leftProperties))
  ) {
    return true;
  }
  if (
    right.additionalProperties === false &&
    [...leftRequired].some((property) => !(property in rightProperties))
  ) {
    return true;
  }
  for (const property of new Set([...leftRequired, ...rightRequired])) {
    const leftSchema = leftProperties[property];
    const rightSchema = rightProperties[property];
    if (leftSchema === undefined || rightSchema === undefined) continue;
    if (
      schemaNodesDefinitelyDisjoint(
        leftSchema,
        leftDocument,
        rightSchema,
        rightDocument,
        new Set(seen),
      )
    ) {
      return true;
    }
  }
  return false;
}

function numericSchemasDefinitelyDisjoint(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftRange = numericRange(left);
  const rightRange = numericRange(right);
  if (leftRange.minimum > rightRange.maximum || rightRange.minimum > leftRange.maximum) return true;
  if (leftRange.minimum === rightRange.maximum) {
    return leftRange.minimumExclusive || rightRange.maximumExclusive;
  }
  if (rightRange.minimum === leftRange.maximum) {
    return rightRange.minimumExclusive || leftRange.maximumExclusive;
  }
  return false;
}

function stringRangesDefinitelyDisjoint(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const minimum = Math.max(numberKeyword(left.minLength, 0), numberKeyword(right.minLength, 0));
  const maximum = Math.min(
    numberKeyword(left.maxLength, Number.POSITIVE_INFINITY),
    numberKeyword(right.maxLength, Number.POSITIVE_INFINITY),
  );
  return minimum > maximum;
}

function schemaDefinitelyRejectsLiteral(
  schema: unknown,
  document: unknown,
  value: unknown,
  seen: Set<string>,
): boolean {
  if (schema === false) return true;
  if (schema === true || !isSchemaRecord(schema)) return false;
  const resolved = resolveLocalSchemaRef(schema, document);
  if (resolved !== schema) {
    const key = schemaIdentity(resolved);
    if (seen.has(key)) return false;
    seen.add(key);
    return schemaDefinitelyRejectsLiteral(resolved, document, value, seen);
  }
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.every((variant) =>
      schemaDefinitelyRejectsLiteral(variant, document, value, new Set(seen)),
    );
  }
  if ("const" in schema && !Object.is(schema.const, value)) return true;
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value)))
    return true;
  const types = schemaTypes(schema);
  const literalType = jsonTypeOf(value);
  if (types && !types.some((type) => schemaTypeAccepts(type, literalType))) return true;
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return true;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return true;
  }
  if (typeof value === "number") {
    const range = numericRange(schema);
    if (value < range.minimum || value > range.maximum) return true;
    if (value === range.minimum && range.minimumExclusive) return true;
    if (value === range.maximum && range.maximumExclusive) return true;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return true;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return true;
  }
  return false;
}

function typeSetsDefinitelyDisjoint(left: readonly string[], right: readonly string[]): boolean {
  return !left.some((leftType) =>
    right.some(
      (rightType) =>
        leftType === rightType ||
        (leftType === "number" && rightType === "integer") ||
        (leftType === "integer" && rightType === "number"),
    ),
  );
}

function commonSchemaTypes(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): string[] {
  if (!left && !right) return [];
  if (!left) return [...right!];
  if (!right) return [...left];
  const result = new Set<string>();
  for (const leftType of left) {
    for (const rightType of right) {
      if (leftType === rightType) result.add(leftType);
      else if (
        (leftType === "number" && rightType === "integer") ||
        (leftType === "integer" && rightType === "number")
      ) {
        result.add("integer");
      }
    }
  }
  return [...result];
}

function schemaTypeAccepts(schemaType: string, literalType: string): boolean {
  return schemaType === literalType || (schemaType === "number" && literalType === "integer");
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value === "object" ? "object" : typeof value;
}

function numericRange(schema: Record<string, unknown>): {
  minimum: number;
  maximum: number;
  minimumExclusive: boolean;
  maximumExclusive: boolean;
} {
  const exclusiveMinimum =
    typeof schema.exclusiveMinimum === "number" ? schema.exclusiveMinimum : undefined;
  const exclusiveMaximum =
    typeof schema.exclusiveMaximum === "number" ? schema.exclusiveMaximum : undefined;
  return {
    minimum: exclusiveMinimum ?? numberKeyword(schema.minimum, Number.NEGATIVE_INFINITY),
    maximum: exclusiveMaximum ?? numberKeyword(schema.maximum, Number.POSITIVE_INFINITY),
    minimumExclusive: exclusiveMinimum !== undefined,
    maximumExclusive: exclusiveMaximum !== undefined,
  };
}

function resolveLocalSchemaRef(schema: Record<string, unknown>, document: unknown): unknown {
  if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/$defs/")) return schema;
  if (!isSchemaRecord(document) || !isSchemaRecord(document.$defs)) return schema;
  return document.$defs[schema.$ref.slice("#/$defs/".length)] ?? schema;
}

function schemaTypes(schema: Record<string, unknown>): string[] | undefined {
  return typeof schema.type === "string"
    ? [schema.type]
    : Array.isArray(schema.type)
      ? schema.type.filter(isString)
      : undefined;
}

function schemaIdentity(schema: unknown): string {
  if (!isSchemaRecord(schema)) return String(schema);
  return `${String(schema.$ref ?? "")}:${String(schema.type ?? "")}:${Object.keys(schema).join(",")}`;
}

function numberKeyword(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
