import { SaxesParser, type SaxesTagNS } from "saxes";

export interface ParsedXmlName {
  readonly localName: string;
  readonly namespace?: string;
  readonly prefix?: string;
}

export interface ParsedXmlAttribute extends ParsedXmlName {
  readonly value: string;
}

export interface ParsedXmlElement extends ParsedXmlName {
  readonly attributes: readonly ParsedXmlAttribute[];
  readonly children: readonly ParsedXmlElement[];
  readonly text: string;
}

interface MutableParsedXmlElement extends ParsedXmlName {
  readonly attributes: ParsedXmlAttribute[];
  readonly children: MutableParsedXmlElement[];
  text: string;
}

const parsedXmlDocumentBrand = Symbol("typespex.parsedXmlDocument");

export interface ParsedXmlDocument {
  readonly [parsedXmlDocumentBrand]: true;
  readonly root: ParsedXmlElement;
}

export interface EncodedXmlName {
  readonly localName: string;
  readonly namespace?: {
    readonly prefix: string;
    readonly uri: string;
  };
}

export interface EncodedXmlAttribute {
  readonly name: EncodedXmlName;
  readonly value: string;
}

export interface EncodedXmlElement {
  readonly name: EncodedXmlName;
  readonly attributes?: readonly EncodedXmlAttribute[];
  readonly children?: readonly EncodedXmlElement[];
  readonly text?: string;
}

const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";

/** Parse exactly one well-formed XML 1.0 document while rejecting DTD declarations. */
export function parseXmlDocument(xml: string): ParsedXmlDocument {
  let root: MutableParsedXmlElement | undefined;
  const stack: MutableParsedXmlElement[] = [];
  const parser = new SaxesParser({
    xmlns: true,
    defaultXMLVersion: "1.0",
    forceXMLVersion: true,
  });

  parser.on("xmldecl", (declaration) => {
    if (declaration.version !== undefined && declaration.version !== "1.0") {
      throw new SyntaxError("Only XML 1.0 documents are supported.");
    }
  });
  parser.on("doctype", () => {
    throw new SyntaxError("XML document type declarations are not supported.");
  });
  parser.on("opentag", (tag) => {
    const element = parsedElement(tag);
    const parent = stack.at(-1);
    if (parent) {
      parent.children.push(element);
    } else if (root) {
      throw new SyntaxError("XML document must contain exactly one root element.");
    } else {
      root = element;
    }
    stack.push(element);
  });
  parser.on("text", (text) => appendText(stack, text));
  parser.on("cdata", (text) => appendText(stack, text));
  parser.on("closetag", () => {
    stack.pop();
  });

  try {
    parser.write(xml).close();
  } catch (error) {
    if (
      error instanceof SyntaxError &&
      (error.message === "XML document type declarations are not supported." ||
        error.message === "Only XML 1.0 documents are supported.")
    ) {
      throw error;
    }
    throw new SyntaxError(error instanceof Error ? error.message : String(error), { cause: error });
  }

  if (!root) throw new SyntaxError("XML document has no root element.");
  return { [parsedXmlDocumentBrand]: true, root };
}

export function isParsedXmlDocument(value: unknown): value is ParsedXmlDocument {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<ParsedXmlDocument>)[parsedXmlDocumentBrand] === true
  );
}

/** Return whether a string is an XML Namespaces 1.0 NCName. */
export function isValidXmlLocalName(name: string): boolean {
  let index = 0;
  for (const character of name) {
    const codePoint = character.codePointAt(0)!;
    if (index === 0 ? !isXmlNameStartCharacter(codePoint) : !isXmlNameCharacter(codePoint)) {
      return false;
    }
    index += 1;
  }
  return index > 0;
}

/** Render an ordered XML tree after validating every generated name and value. */
export function renderXmlDocument(root: EncodedXmlElement): string {
  return renderXmlElement(root, collectNamespaces(root), true);
}

function parsedElement(tag: SaxesTagNS): MutableParsedXmlElement {
  const attributes = Object.values(tag.attributes)
    .filter((attribute) => attribute.uri !== XMLNS_NAMESPACE)
    .map((attribute): ParsedXmlAttribute => ({
      localName: attribute.local,
      ...(attribute.uri ? { namespace: attribute.uri } : {}),
      ...(attribute.prefix ? { prefix: attribute.prefix } : {}),
      value: attribute.value,
    }));
  return {
    localName: tag.local,
    ...(tag.uri ? { namespace: tag.uri } : {}),
    ...(tag.prefix ? { prefix: tag.prefix } : {}),
    attributes,
    children: [],
    text: "",
  };
}

function appendText(stack: MutableParsedXmlElement[], text: string): void {
  const element = stack.at(-1);
  if (!element) {
    if (text.trim().length > 0) {
      throw new SyntaxError("XML character data must be inside the root element.");
    }
    return;
  }
  element.text += text;
}

function collectNamespaces(root: EncodedXmlElement): ReadonlyMap<string, string> {
  const namespaces = new Map<string, string>();
  visit(root);
  return namespaces;

  function visit(element: EncodedXmlElement): void {
    add(element.name);
    for (const attribute of element.attributes ?? []) add(attribute.name);
    for (const child of element.children ?? []) visit(child);
  }

  function add(name: EncodedXmlName): void {
    const namespace = name.namespace;
    if (!namespace) return;
    validateXmlName(namespace.prefix, "namespace prefix");
    if (namespace.prefix === "xmlns") {
      throw new TypeError('The reserved "xmlns" prefix cannot be used.');
    }
    if (namespace.prefix === "xml") {
      if (namespace.uri !== XML_NAMESPACE) {
        throw new TypeError('The reserved "xml" prefix has an invalid namespace URI.');
      }
      return;
    }
    if (namespace.uri.length === 0) throw new TypeError("XML namespace URIs cannot be empty.");
    if (namespace.uri === XML_NAMESPACE) {
      throw new TypeError('Only the reserved "xml" prefix may use the XML namespace URI.');
    }
    if (namespace.uri === XMLNS_NAMESPACE) {
      throw new TypeError("The XMLNS namespace URI cannot be used.");
    }
    const existing = namespaces.get(namespace.prefix);
    if (existing !== undefined && existing !== namespace.uri) {
      throw new TypeError(
        `XML prefix ${JSON.stringify(namespace.prefix)} maps to conflicting namespace URIs.`,
      );
    }
    namespaces.set(namespace.prefix, namespace.uri);
  }
}

function renderXmlElement(
  element: EncodedXmlElement,
  namespaces: ReadonlyMap<string, string>,
  root: boolean,
): string {
  const qualifiedName = encodeQualifiedName(element.name);
  const attributes: string[] = [];
  if (root) {
    for (const [prefix, uri] of namespaces) {
      attributes.push(`xmlns:${prefix}="${escapeXmlAttribute(uri)}"`);
    }
  }

  const expandedAttributeNames = new Set<string>();
  for (const attribute of element.attributes ?? []) {
    if (attribute.name.localName === "xmlns" && attribute.name.namespace === undefined) {
      throw new TypeError('An XML attribute cannot use the reserved name "xmlns".');
    }
    const expandedName = `${attribute.name.namespace?.uri ?? ""}\0${attribute.name.localName}`;
    if (expandedAttributeNames.has(expandedName)) {
      throw new TypeError(
        `Duplicate XML attribute ${JSON.stringify(encodeQualifiedName(attribute.name))}.`,
      );
    }
    expandedAttributeNames.add(expandedName);
    attributes.push(
      `${encodeQualifiedName(attribute.name)}="${escapeXmlAttribute(attribute.value)}"`,
    );
  }

  const opening =
    attributes.length > 0 ? `<${qualifiedName} ${attributes.join(" ")}` : `<${qualifiedName}`;
  const children = (element.children ?? []).map((child) =>
    renderXmlElement(child, namespaces, false),
  );
  const text = element.text === undefined ? "" : escapeXmlText(element.text);
  if (text.length === 0 && children.length === 0) return `${opening}/>`;
  return `${opening}>${text}${children.join("")}</${qualifiedName}>`;
}

function encodeQualifiedName(name: EncodedXmlName): string {
  validateXmlName(name.localName, "local name");
  if (!name.namespace) return name.localName;
  validateXmlName(name.namespace.prefix, "namespace prefix");
  return `${name.namespace.prefix}:${name.localName}`;
}

function validateXmlName(name: string, description: string): void {
  if (!isValidXmlLocalName(name)) {
    throw new TypeError(`Invalid XML ${description} ${JSON.stringify(name)}.`);
  }
}

function isXmlNameStartCharacter(codePoint: number): boolean {
  return (
    codePoint === 0x5f ||
    (codePoint >= 0x41 && codePoint <= 0x5a) ||
    (codePoint >= 0x61 && codePoint <= 0x7a) ||
    (codePoint >= 0xc0 && codePoint <= 0xd6) ||
    (codePoint >= 0xd8 && codePoint <= 0xf6) ||
    (codePoint >= 0xf8 && codePoint <= 0x2ff) ||
    (codePoint >= 0x370 && codePoint <= 0x37d) ||
    (codePoint >= 0x37f && codePoint <= 0x1fff) ||
    (codePoint >= 0x200c && codePoint <= 0x200d) ||
    (codePoint >= 0x2070 && codePoint <= 0x218f) ||
    (codePoint >= 0x2c00 && codePoint <= 0x2fef) ||
    (codePoint >= 0x3001 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfdcf) ||
    (codePoint >= 0xfdf0 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0xeffff)
  );
}

function isXmlNameCharacter(codePoint: number): boolean {
  return (
    isXmlNameStartCharacter(codePoint) ||
    codePoint === 0x2d ||
    codePoint === 0x2e ||
    (codePoint >= 0x30 && codePoint <= 0x39) ||
    codePoint === 0xb7 ||
    (codePoint >= 0x300 && codePoint <= 0x36f) ||
    (codePoint >= 0x203f && codePoint <= 0x2040)
  );
}

function escapeXmlText(value: string): string {
  validateXmlCharacters(value);
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r", "&#13;");
}

function escapeXmlAttribute(value: string): string {
  validateXmlCharacters(value);
  return value.replace(/[&<>"\t\n\r]/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "\t":
        return "&#9;";
      case "\n":
        return "&#10;";
      default:
        return "&#13;";
    }
  });
}

function validateXmlCharacters(value: string): void {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint !== 0x09 &&
      codePoint !== 0x0a &&
      codePoint !== 0x0d &&
      (codePoint < 0x20 ||
        (codePoint > 0xd7ff && codePoint < 0xe000) ||
        (codePoint > 0xfffd && codePoint < 0x10000) ||
        codePoint > 0x10ffff)
    ) {
      throw new TypeError(
        `XML values cannot contain character U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}.`,
      );
    }
  }
}
