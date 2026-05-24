const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const RESERVED_IDENTIFIERS = new Set([
  "abstract",
  "any",
  "as",
  "asserts",
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
  "global",
  "if",
  "implements",
  "import",
  "in",
  "infer",
  "instanceof",
  "interface",
  "intrinsic",
  "is",
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
  "out",
  "override",
  "package",
  "private",
  "protected",
  "public",
  "readonly",
  "require",
  "return",
  "satisfies",
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
  "unique",
  "unknown",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const UNSAFE_DOT_PROPERTIES = new Set(["__proto__", "constructor", "prototype"]);

function isIdentifierText(value: string): boolean {
  return IDENTIFIER_RE.test(value);
}

export function isTsIdentifier(value: string): boolean {
  return isIdentifierText(value) && !RESERVED_IDENTIFIERS.has(value);
}

export function tsIdentifier(value: string | undefined, fallback = "value"): string {
  const raw = value && value.length > 0 ? value : fallback;
  let identifier = raw.replace(/[^A-Za-z0-9_$]/g, "_");
  if (!/^[A-Za-z_$]/.test(identifier)) {
    identifier = `_${identifier}`;
  }
  if (!isIdentifierText(identifier)) {
    identifier = fallback;
  }
  if (RESERVED_IDENTIFIERS.has(identifier)) {
    identifier = `${identifier}_`;
  }
  return identifier;
}

export function tsPropertyName(value: string): string {
  return isTsIdentifier(value) ? value : JSON.stringify(value);
}

export function tsPropertyDeclaration(
  name: string,
  type: string,
  options: { readonly?: boolean; optional?: boolean } = {},
): string {
  const readonlyPrefix = options.readonly ? "readonly " : "";
  const optional = options.optional ? "?" : "";
  return `${readonlyPrefix}${tsPropertyName(name)}${optional}: ${type}`;
}

export function tsObjectKey(value: string): string {
  if (value === "__proto__") {
    return `[${JSON.stringify(value)}]`;
  }
  return tsPropertyName(value);
}

export function tsPropertyAccess(target: string, property: string): string {
  if (isIdentifierText(property) && !UNSAFE_DOT_PROPERTIES.has(property)) {
    return `${target}.${property}`;
  }
  return `${target}[${JSON.stringify(property)}]`;
}
