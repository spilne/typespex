const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const RESERVED = new Set([
  "abstract",
  "any",
  "as",
  "asserts",
  "await",
  "bigint",
  "boolean",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "declare",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "get",
  "if",
  "implements",
  "import",
  "in",
  "infer",
  "instanceof",
  "interface",
  "keyof",
  "let",
  "module",
  "namespace",
  "never",
  "new",
  "null",
  "number",
  "object",
  "of",
  "package",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "set",
  "static",
  "string",
  "super",
  "switch",
  "symbol",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "unknown",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

export function typescriptIdentifier(value: string, fallback = "value"): string {
  let result = value.replace(/[^A-Za-z0-9_$]/g, "_");
  if (!/^[A-Za-z_$]/.test(result)) result = `_${result}`;
  if (!IDENTIFIER.test(result)) result = fallback;
  if (RESERVED.has(result)) result = `${result}_`;
  return result;
}

export function pascalCase(value: string): string {
  const words = splitWords(value);
  return words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join("") || "Value";
}

export function camelCase(value: string): string {
  const pascal = pascalCase(value);
  return pascal[0]!.toLowerCase() + pascal.slice(1);
}

export function kebabCase(value: string): string {
  return splitWords(value)
    .map((word) => word.toLowerCase())
    .join("-");
}

export function typescriptString(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Expected a JSON-compatible value.");
  return serialized.replace(/[<>\u2028\u2029]/g, (character) => {
    switch (character) {
      case "<":
        return "\\u003C";
      case ">":
        return "\\u003E";
      case "\u2028":
        return "\\u2028";
      default:
        return "\\u2029";
    }
  });
}

export function typescriptProperty(value: string): string {
  return IDENTIFIER.test(value) && !RESERVED.has(value) ? value : typescriptString(value);
}

function splitWords(value: string): string[] {
  const separated = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return separated.match(/[A-Za-z0-9]+/g) ?? [];
}
