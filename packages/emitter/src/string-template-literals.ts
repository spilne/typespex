import {
  compilerAssert,
  type StringLiteral,
  type StringTemplate,
  type Type,
} from "@typespec/compiler";
import { tsLiteral } from "./typescript-names.js";

export type StringLikeLiteral = StringLiteral | StringTemplate;

export function isStringLikeLiteral(type: Type): type is StringLikeLiteral {
  return type.kind === "String" || type.kind === "StringTemplate";
}

/** Returns the one exact string represented by a literal or resolved template. */
export function getStringLiteralValue(type: StringLikeLiteral): string | undefined {
  return type.kind === "String" ? type.value : type.stringValue;
}

export function stringLiteralExpression(type: StringLikeLiteral): string {
  const value = getStringLiteralValue(type);
  compilerAssert(
    value !== undefined,
    "An unresolved string template reached TypeScript emission.",
    type,
  );
  return tsLiteral(value);
}
