import {
  compilerAssert,
  type EnumMember,
  type NumericLiteral,
  type Program,
} from "@typespec/compiler";
import { tsLiteral } from "./typescript-names.js";

const MAX_EXACT_JSON_INTEGER_DIGITS = 20;
const MIN_SAFE_INTEGER = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

export interface SupportedNumericLiteral {
  readonly supported: true;
  readonly kind: "number" | "bigint";
  /** A TypeScript expression that preserves the handler-facing value. */
  readonly expression: string;
  /** Stable exact identity used for discriminator collision checks. */
  readonly key: string;
  readonly exactValue: string;
}

export interface UnsupportedNumericLiteral {
  readonly supported: false;
  readonly exactValue: string;
  readonly reason: string;
}

export type NumericLiteralResolution = SupportedNumericLiteral | UnsupportedNumericLiteral;

/** Resolves one exact TypeSpec numeric literal to the runtime's number/bigint policy. */
export function resolveNumericLiteral(type: NumericLiteral): NumericLiteralResolution {
  const exactValue = type.numericValue.toString();

  if (type.numericValue.isInteger) {
    const integer = BigInt(exactValue);
    if (integer >= MIN_SAFE_INTEGER && integer <= MAX_SAFE_INTEGER) {
      return {
        supported: true,
        kind: "number",
        expression: exactValue,
        key: `number:${exactValue}`,
        exactValue,
      };
    }

    const digits = exactValue.startsWith("-") ? exactValue.length - 1 : exactValue.length;
    if (digits > MAX_EXACT_JSON_INTEGER_DIGITS) {
      return {
        supported: false,
        exactValue,
        reason: `integer literals may contain at most ${MAX_EXACT_JSON_INTEGER_DIGITS} digits for exact JSON decoding`,
      };
    }

    return {
      supported: true,
      kind: "bigint",
      expression: `${exactValue}n`,
      key: `bigint:${exactValue}`,
      exactValue,
    };
  }

  const numberValue = type.numericValue.asNumber();
  if (numberValue === null || !Number.isFinite(numberValue)) {
    return {
      supported: false,
      exactValue,
      reason:
        "the non-integer literal cannot be represented exactly by the JavaScript number mapping",
    };
  }

  const expression = String(numberValue);
  return {
    supported: true,
    kind: "number",
    expression,
    key: `number:${exactValue}`,
    exactValue,
  };
}

/** Exact numeric source for an enum member, following spread-member origins. */
export function getEnumMemberNumericLiteral(
  program: Program,
  member: EnumMember,
): NumericLiteral | undefined {
  const seen = new Set<EnumMember>();
  let current: EnumMember | undefined = member;
  while (current && !seen.has(current)) {
    seen.add(current);
    const valueNode = current.node?.value;
    if (valueNode) {
      const valueType = program.checker.getTypeForNode(valueNode);
      if (valueType.kind === "Number") return valueType;
    }
    current = current.sourceMember;
  }
  return undefined;
}

export function numericLiteralExpression(type: NumericLiteral): string {
  const resolved = resolveNumericLiteral(type);
  compilerAssert(
    resolved.supported,
    `Unsupported numeric literal ${resolved.exactValue} reached TypeScript emission.`,
    type,
  );
  return resolved.expression;
}

export function enumMemberLiteralExpression(program: Program, member: EnumMember): string {
  if (member.value === undefined) return tsLiteral(member.name);
  if (typeof member.value === "string") return tsLiteral(member.value);
  const source = getEnumMemberNumericLiteral(program, member);
  return source ? numericLiteralExpression(source) : String(member.value);
}
