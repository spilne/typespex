import { Either, isLeft } from "../core/either.js";
import { Decoder, fail, succeed, type DecoderResult } from "./decoder.js";
import { JsonSerializationError, type JsonSerializer } from "./json-serializer.js";
import {
  isParsedXmlDocument,
  isValidXmlLocalName,
  renderXmlDocument,
  validateXmlCharacters,
  type EncodedXmlElement,
  type EncodedXmlName,
  type ParsedXmlElement,
} from "./xml-parser.js";

export interface XmlNamespace {
  readonly prefix: string;
  readonly uri: string;
}

export interface XmlCodecOptions {
  readonly namespace?: XmlNamespace;
}

export interface XmlObjectProperty {
  readonly property: string;
  readonly name: string;
  readonly codec: XmlCodec<unknown>;
  readonly optional?: boolean;
  readonly attribute?: boolean;
  readonly unwrapped?: boolean;
  readonly namespace?: XmlNamespace;
}

export interface XmlObjectCodecOptions extends XmlCodecOptions {
  readonly allowUnknown?: boolean;
  readonly additionalProperties?: XmlCodec<unknown>;
  readonly forbiddenNames?: readonly string[];
}

/** Error raised when a handler result cannot be represented by its TypeSpec XML schema. */
export class XmlSerializationError extends TypeError {
  constructor(
    readonly path: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${path}: ${message}`, options);
    this.name = "XmlSerializationError";
  }
}

/** Bidirectional codec for one XML document root. */
export class XmlCodec<A> extends Decoder<A> {
  constructor(
    private readonly decodeDocument: (input: unknown) => DecoderResult<A>,
    private readonly encodeDocument: (value: A, path: string) => string,
  ) {
    super();
  }

  decode(input: unknown): DecoderResult<A> {
    return this.decodeDocument(input);
  }

  serialize(value: A, path = "$response"): string {
    return this.encodeDocument(value, path);
  }
}

type XmlCodecShape = "scalar" | "array" | "record" | "object";

interface XmlCodecDefinition<A> {
  readonly shape: XmlCodecShape;
  readonly name: EncodedXmlName;
  readonly arrayItem?: XmlCodec<unknown>;
  readonly decodeContent: (element: ParsedXmlElement) => DecoderResult<A>;
  readonly encodeContent: (value: A, path: string) => EncodedXmlContent;
}

interface EncodedXmlContent {
  readonly attributes?: EncodedXmlElement["attributes"];
  readonly children?: EncodedXmlElement["children"];
  readonly text?: string;
}

const definitions = new WeakMap<XmlCodec<unknown>, XmlCodecDefinition<unknown>>();

function scalarXmlCodec<A>(
  name: string,
  decoder: Decoder<A>,
  serializer: JsonSerializer<A>,
  options: XmlCodecOptions = {},
): XmlCodec<A> {
  return createXmlCodec<A>({
    shape: "scalar",
    name: encodedName(name, options.namespace),
    decodeContent: (element) => {
      if (element.children.length > 0 || element.attributes.length > 0) {
        return fail("", "Expected XML text content.");
      }
      const decoded = decoder.decode(element.text);
      if (!isLeft(decoded)) return decoded;
      const trimmed = element.text.trim();
      return trimmed === element.text ? decoded : decoder.decode(trimmed);
    },
    encodeContent: (value, path) => {
      let wireValue: unknown;
      try {
        wireValue = serializer.serialize(value, path);
      } catch (error) {
        throw asXmlSerializationError(error, path);
      }
      const text = xmlScalarText(wireValue, path);
      const validated = decoder.decode(text);
      if (isLeft(validated)) {
        throw new XmlSerializationError(
          path,
          validated.left
            .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
            .join(" "),
        );
      }
      return { text };
    },
  });
}

function arrayXmlCodec<A>(
  name: string,
  item: XmlCodec<A>,
  options: XmlCodecOptions = {},
): XmlCodec<A[]> {
  const itemDefinition = () => getDefinition(item);
  return createXmlCodec<A[]>({
    shape: "array",
    name: encodedName(name, options.namespace),
    arrayItem: item as XmlCodec<unknown>,
    decodeContent: (element) => {
      const decoded: A[] = [];
      let issues: Array<{ path: string; message: string }> | undefined;
      for (const attribute of element.attributes) {
        (issues ??= []).push({
          path: attributePath(attribute.localName),
          message: "Unexpected XML attribute.",
        });
      }
      if (element.text.trim().length > 0) {
        (issues ??= []).push({ path: propertyPath("#text"), message: "Unexpected XML text." });
      }
      let itemIndex = 0;
      for (const child of element.children) {
        if (!matchesName(child, itemDefinition().name)) {
          (issues ??= []).push({
            path: propertyPath(child.localName),
            message: "Unexpected XML element.",
          });
          continue;
        }
        const index = itemIndex;
        itemIndex += 1;
        const result = itemDefinition().decodeContent(child);
        if (isLeft(result)) {
          (issues ??= []).push(
            ...result.left.map((issue) => ({
              path: `[${index}]${issue.path}`,
              message: issue.message,
            })),
          );
        } else {
          decoded.push(result.right as A);
        }
      }
      return issues ? Either.left(issues) : succeed(decoded);
    },
    encodeContent: (value, path) => {
      if (!Array.isArray(value)) throw new XmlSerializationError(path, "Expected an array.");
      return {
        children: Array.from(value, (entry, index) =>
          encodeElement(itemDefinition(), entry, `${path}[${index}]`),
        ),
      };
    },
  });
}

function recordXmlCodec<A>(
  name: string,
  valueCodec: XmlCodec<A>,
  options: XmlCodecOptions = {},
): XmlCodec<Record<string, A>> {
  const valueDefinition = () => getDefinition(valueCodec);
  return createXmlCodec({
    shape: "record",
    name: encodedName(name, options.namespace),
    decodeContent: (element) => {
      const output: Record<string, A> = {};
      let issues: Array<{ path: string; message: string }> | undefined;
      for (const attribute of element.attributes) {
        (issues ??= []).push({
          path: attributePath(attribute.localName),
          message: "Unexpected XML attribute.",
        });
      }
      if (element.text.trim().length > 0) {
        (issues ??= []).push({ path: propertyPath("#text"), message: "Unexpected XML text." });
      }
      for (const child of element.children) {
        const key = child.localName;
        if (child.namespace !== undefined) {
          (issues ??= []).push({
            path: propertyPath(key),
            message: "Record entries cannot use an XML namespace.",
          });
          continue;
        }
        if (Object.prototype.hasOwnProperty.call(output, key)) {
          (issues ??= []).push({ path: propertyPath(key), message: "Duplicate XML element." });
          continue;
        }
        const decoded = valueDefinition().decodeContent(child);
        if (isLeft(decoded)) {
          (issues ??= []).push(
            ...decoded.left.map((issue) => ({
              path: `${propertyPath(key)}${issue.path}`,
              message: issue.message,
            })),
          );
        } else {
          defineDataProperty(output, key, decoded.right as A);
        }
      }
      return issues ? Either.left(issues) : succeed(output);
    },
    encodeContent: (value, path) => {
      const source = expectPlainXmlObject(value, path);
      return {
        children: Object.keys(source).map((key) =>
          encodeElement(
            valueDefinition(),
            source[key] as A,
            `${path}${propertyPath(key)}`,
            encodedDynamicName(key, `${path}${propertyPath(key)}`),
          ),
        ),
      };
    },
  });
}

function objectXmlCodec<A extends object>(
  name: string,
  properties: readonly XmlObjectProperty[],
  options: XmlObjectCodecOptions = {},
): XmlCodec<A> {
  validateObjectProperties(properties);
  if (
    options.additionalProperties &&
    properties.some(
      (property) => property.unwrapped && getDefinition(property.codec).shape === "scalar",
    )
  ) {
    throw new TypeError(
      "An XML object with unwrapped text cannot also contain additional properties.",
    );
  }
  const forbiddenNames = new Set(options.forbiddenNames ?? []);
  const declaredProperties = new Set(properties.map((property) => property.property));
  const declaredElementNames = new Set(
    properties
      .filter(
        (property) =>
          !property.attribute &&
          property.namespace === undefined &&
          (!property.unwrapped || getDefinition(property.codec).shape === "array"),
      )
      .map((property) => property.name),
  );
  return createXmlCodec({
    shape: "object",
    name: encodedName(name, options.namespace),
    decodeContent: (element) => {
      const output: Record<string, unknown> = {};
      const claimedChildren = new Set<ParsedXmlElement>();
      const claimedAttributes = new Set(element.attributes);
      let claimsText = false;
      let issues: Array<{ path: string; message: string }> | undefined;

      for (const property of properties) {
        const propertyName = encodedName(property.name, property.namespace);
        const propertyDefinition = getDefinition(property.codec);
        let decoded: DecoderResult<unknown>;

        if (property.attribute) {
          const matches = element.attributes.filter((attribute) =>
            matchesName(attribute, propertyName),
          );
          for (const attribute of matches) claimedAttributes.delete(attribute);
          if (matches.length > 1) {
            decoded = fail("", "Duplicate XML attribute.");
          } else if (matches.length === 0) {
            decoded = property.optional
              ? succeed(undefined)
              : fail("", "Required XML attribute is missing.");
          } else {
            decoded = propertyDefinition.decodeContent(textElement(matches[0]!.value));
          }
        } else if (property.unwrapped && propertyDefinition.shape === "array") {
          const matches = element.children.filter((child) => matchesName(child, propertyName));
          for (const child of matches) claimedChildren.add(child);
          if (matches.length === 0 && property.optional) {
            decoded = succeed(undefined);
          } else {
            decoded = decodeUnwrappedArray(propertyDefinition, matches);
          }
        } else if (property.unwrapped) {
          claimsText = true;
          decoded =
            property.optional && element.text.trim().length === 0
              ? succeed(undefined)
              : propertyDefinition.decodeContent(textElement(element.text.trim()));
        } else {
          const matches = element.children.filter((child) => matchesName(child, propertyName));
          for (const child of matches) claimedChildren.add(child);
          if (matches.length > 1) {
            decoded = fail("", "Duplicate XML element.");
          } else if (matches.length === 0) {
            decoded = property.optional
              ? succeed(undefined)
              : fail("", "Required XML element is missing.");
          } else {
            decoded = propertyDefinition.decodeContent(matches[0]!);
          }
        }

        if (isLeft(decoded)) {
          (issues ??= []).push(
            ...decoded.left.map((issue) => ({
              path: `${propertyPath(property.name)}${issue.path}`,
              message: issue.message,
            })),
          );
        } else if (decoded.right !== undefined) {
          defineDataProperty(output, property.property, decoded.right);
        }
      }

      if (!claimsText && element.text.trim().length > 0) {
        (issues ??= []).push({ path: propertyPath("#text"), message: "Unexpected XML text." });
      }

      for (const attribute of claimedAttributes) {
        if (forbiddenNames.has(attribute.localName) || !options.allowUnknown) {
          (issues ??= []).push({
            path: attributePath(attribute.localName),
            message: "Unexpected XML attribute.",
          });
        }
      }

      for (const child of element.children) {
        if (claimedChildren.has(child)) continue;
        if (forbiddenNames.has(child.localName)) {
          (issues ??= []).push({
            path: propertyPath(child.localName),
            message: "Unexpected XML element.",
          });
          continue;
        }
        if (options.additionalProperties) {
          if (child.namespace !== undefined) {
            (issues ??= []).push({
              path: propertyPath(child.localName),
              message: "Additional properties cannot use an XML namespace.",
            });
            continue;
          }
          if (
            declaredProperties.has(child.localName) ||
            Object.prototype.hasOwnProperty.call(output, child.localName)
          ) {
            (issues ??= []).push({
              path: propertyPath(child.localName),
              message: "Additional XML element conflicts with another property.",
            });
            continue;
          }
          const decoded = getDefinition(options.additionalProperties).decodeContent(child);
          if (isLeft(decoded)) {
            (issues ??= []).push(
              ...decoded.left.map((issue) => ({
                path: `${propertyPath(child.localName)}${issue.path}`,
                message: issue.message,
              })),
            );
          } else {
            defineDataProperty(output, child.localName, decoded.right);
          }
        } else if (claimsText || !options.allowUnknown) {
          (issues ??= []).push({
            path: propertyPath(child.localName),
            message: "Unexpected XML element.",
          });
        }
      }

      return issues ? Either.left(issues) : succeed(output as A);
    },
    encodeContent: (value, path) => {
      const source = expectXmlObject(value, path);
      const attributes: NonNullable<EncodedXmlElement["attributes"]>[number][] = [];
      const children: EncodedXmlElement[] = [];
      let text: string | undefined;

      for (const property of properties) {
        const propertyPathValue = `${path}${propertyPath(property.property)}`;
        const present = Object.prototype.hasOwnProperty.call(source, property.property);
        const propertyValue = present ? source[property.property] : undefined;
        if (!present || propertyValue === undefined) {
          if (property.optional) continue;
          throw new XmlSerializationError(propertyPathValue, "Required property is missing.");
        }

        const propertyName = encodedName(property.name, property.namespace);
        const propertyDefinition = getDefinition(property.codec);
        if (property.attribute) {
          const content = encodeContent(propertyDefinition, propertyValue, propertyPathValue);
          attributes.push({
            name: propertyName,
            value: scalarContentText(content, propertyPathValue),
          });
        } else if (property.unwrapped && propertyDefinition.shape === "array") {
          children.push(
            ...encodeUnwrappedArray(
              propertyDefinition,
              propertyValue,
              propertyName,
              propertyPathValue,
            ),
          );
        } else if (property.unwrapped) {
          if (text !== undefined) {
            throw new XmlSerializationError(
              propertyPathValue,
              "Only one unwrapped text property is allowed.",
            );
          }
          text = scalarContentText(
            encodeContent(propertyDefinition, propertyValue, propertyPathValue),
            propertyPathValue,
          );
        } else {
          children.push(
            encodeElement(propertyDefinition, propertyValue, propertyPathValue, propertyName),
          );
        }
      }

      if (options.additionalProperties) {
        const additionalDefinition = getDefinition(options.additionalProperties);
        for (const key of Object.keys(source)) {
          if (declaredProperties.has(key)) continue;
          if (declaredElementNames.has(key)) {
            throw new XmlSerializationError(
              `${path}${propertyPath(key)}`,
              `Additional property conflicts with encoded XML name ${JSON.stringify(key)}.`,
            );
          }
          const propertyValue = source[key];
          if (propertyValue === undefined) continue;
          children.push(
            encodeElement(
              additionalDefinition,
              propertyValue,
              `${path}${propertyPath(key)}`,
              encodedDynamicName(key, `${path}${propertyPath(key)}`),
            ),
          );
        }
      }

      return { attributes, children, text };
    },
  });
}

function lazyXmlCodec<A>(resolve: () => XmlCodec<A>): XmlCodec<A> {
  let resolved: XmlCodecDefinition<A> | undefined;
  const getResolved = (): XmlCodecDefinition<A> => {
    resolved ??= getDefinition(resolve());
    return resolved;
  };
  return createXmlCodec({
    get shape() {
      return getResolved().shape;
    },
    get name() {
      return getResolved().name;
    },
    get arrayItem() {
      return getResolved().arrayItem;
    },
    decodeContent: (element) => getResolved().decodeContent(element),
    encodeContent: (value, path) => getResolved().encodeContent(value, path),
  });
}

function createXmlCodec<A>(definition: XmlCodecDefinition<A>): XmlCodec<A> {
  const codec = new XmlCodec<A>(
    (input) => {
      if (!isParsedXmlDocument(input)) return fail("", "Expected a parsed XML document.");
      if (!matchesName(input.root, definition.name)) {
        return fail("", `Expected XML root element ${formatEncodedName(definition.name)}.`);
      }
      return definition.decodeContent(input.root);
    },
    (value, path) => {
      try {
        return renderXmlDocument(encodeElement(definition, value, path));
      } catch (error) {
        throw asXmlSerializationError(error, path);
      }
    },
  );
  definitions.set(codec as XmlCodec<unknown>, definition as XmlCodecDefinition<unknown>);
  return codec;
}

function getDefinition<A>(codec: XmlCodec<A>): XmlCodecDefinition<A> {
  const definition = definitions.get(codec as XmlCodec<unknown>);
  if (!definition) throw new TypeError("Unknown XML codec implementation.");
  return definition as XmlCodecDefinition<A>;
}

function decodeUnwrappedArray(
  definition: XmlCodecDefinition<unknown>,
  elements: readonly ParsedXmlElement[],
): DecoderResult<unknown[]> {
  const item = definition.arrayItem;
  if (!item) return fail("", "Invalid XML array codec.");
  const itemDefinition = getDefinition(item);
  const output: unknown[] = [];
  let issues: Array<{ path: string; message: string }> | undefined;
  for (let index = 0; index < elements.length; index += 1) {
    const decoded = itemDefinition.decodeContent(elements[index]!);
    if (isLeft(decoded)) {
      (issues ??= []).push(
        ...decoded.left.map((issue) => ({
          path: `[${index}]${issue.path}`,
          message: issue.message,
        })),
      );
    } else {
      output.push(decoded.right);
    }
  }
  return issues ? Either.left(issues) : succeed(output);
}

function encodeUnwrappedArray(
  definition: XmlCodecDefinition<unknown>,
  value: unknown,
  name: EncodedXmlName,
  path: string,
): EncodedXmlElement[] {
  if (!Array.isArray(value)) throw new XmlSerializationError(path, "Expected an array.");
  const item = definition.arrayItem;
  if (!item) throw new XmlSerializationError(path, "Invalid XML array codec.");
  const itemDefinition = getDefinition(item);
  return Array.from(value, (entry, index) =>
    encodeElement(itemDefinition, entry, `${path}[${index}]`, name),
  );
}

function encodeElement<A>(
  definition: XmlCodecDefinition<A>,
  value: A,
  path: string,
  name: EncodedXmlName = definition.name,
): EncodedXmlElement {
  return { name, ...encodeContent(definition, value, path) };
}

function encodeContent<A>(
  definition: XmlCodecDefinition<A>,
  value: A,
  path: string,
): EncodedXmlContent {
  try {
    return definition.encodeContent(value, path);
  } catch (error) {
    throw asXmlSerializationError(error, path);
  }
}

function scalarContentText(content: EncodedXmlContent, path: string): string {
  if ((content.attributes?.length ?? 0) > 0 || (content.children?.length ?? 0) > 0) {
    throw new XmlSerializationError(path, "Expected an XML scalar value.");
  }
  return content.text ?? "";
}

function xmlScalarText(value: unknown, path: string): string {
  let text: string;
  switch (typeof value) {
    case "string":
      text = value;
      break;
    case "boolean":
    case "bigint":
      text = String(value);
      break;
    case "number":
      if (!Number.isFinite(value)) {
        throw new XmlSerializationError(
          path,
          "Expected a string, finite number, bigint, or boolean XML value.",
        );
      }
      text = String(value);
      break;
    default:
      throw new XmlSerializationError(
        path,
        "Expected a string, finite number, bigint, or boolean XML value.",
      );
  }
  try {
    validateXmlCharacters(text);
  } catch (error) {
    throw asXmlSerializationError(error, path);
  }
  return text;
}

function validateObjectProperties(properties: readonly XmlObjectProperty[]): void {
  const sourceNames = new Set<string>();
  const elementNames = new Set<string>();
  const attributeNames = new Set<string>();
  let textProperties = 0;
  for (const property of properties) {
    encodedName(property.name, property.namespace);
    if (property.attribute && property.name === "xmlns" && property.namespace === undefined) {
      throw new TypeError('An XML attribute cannot use the reserved name "xmlns".');
    }
    const propertyShape =
      property.attribute || property.unwrapped ? getDefinition(property.codec).shape : undefined;
    if (property.attribute && propertyShape !== "scalar") {
      throw new TypeError("XML attributes require a scalar codec.");
    }
    if (property.unwrapped && propertyShape !== "scalar" && propertyShape !== "array") {
      throw new TypeError("Unwrapped XML properties require a scalar or array codec.");
    }
    if (property.unwrapped && propertyShape === "scalar" && property.namespace !== undefined) {
      throw new TypeError("Unwrapped XML text properties cannot declare a namespace.");
    }
    if (sourceNames.has(property.property)) {
      throw new TypeError(`Duplicate XML source property ${JSON.stringify(property.property)}.`);
    }
    sourceNames.add(property.property);
    const key = `${property.namespace?.uri ?? ""}\0${property.name}`;
    if (property.attribute && property.unwrapped) {
      throw new TypeError("An XML property cannot be both an attribute and unwrapped.");
    }
    const unwrappedArray = property.unwrapped && propertyShape === "array";
    const wireNames = property.attribute ? attributeNames : elementNames;
    if ((!property.unwrapped || unwrappedArray) && wireNames.has(key)) {
      throw new TypeError(`Duplicate XML property name ${JSON.stringify(property.name)}.`);
    }
    if (!property.unwrapped || unwrappedArray) wireNames.add(key);
    if (property.unwrapped && !unwrappedArray) textProperties += 1;
  }
  if (textProperties > 1) throw new TypeError("Only one unwrapped XML text property is allowed.");
  if (textProperties > 0 && elementNames.size > 0) {
    throw new TypeError("An XML object with unwrapped text cannot also contain child elements.");
  }
}

function matchesName(
  actual: { readonly localName: string; readonly namespace?: string },
  expected: EncodedXmlName,
): boolean {
  return actual.localName === expected.localName && actual.namespace === expected.namespace?.uri;
}

function encodedName(localName: string, namespace?: XmlNamespace): EncodedXmlName {
  if (!isValidXmlLocalName(localName)) {
    throw new TypeError(`Invalid unqualified XML name ${JSON.stringify(localName)}.`);
  }
  validateNamespace(namespace);
  return namespace ? { localName, namespace } : { localName };
}

function encodedDynamicName(localName: string, path: string): EncodedXmlName {
  try {
    return encodedName(localName);
  } catch (error) {
    throw asXmlSerializationError(error, path);
  }
}

function validateNamespace(namespace: XmlNamespace | undefined): void {
  if (!namespace) return;
  if (namespace.uri.length === 0) throw new TypeError("XML namespace URIs cannot be empty.");
  if (!isValidXmlLocalName(namespace.prefix)) {
    throw new TypeError(`Invalid XML namespace prefix ${JSON.stringify(namespace.prefix)}.`);
  }
  if (namespace.prefix === "xmlns")
    throw new TypeError('The reserved "xmlns" prefix cannot be used.');
  if (namespace.prefix === "xml" && namespace.uri !== "http://www.w3.org/XML/1998/namespace") {
    throw new TypeError('The reserved "xml" prefix has an invalid namespace URI.');
  }
  if (namespace.prefix !== "xml" && namespace.uri === "http://www.w3.org/XML/1998/namespace") {
    throw new TypeError('Only the reserved "xml" prefix may use the XML namespace URI.');
  }
  if (namespace.uri === "http://www.w3.org/2000/xmlns/") {
    throw new TypeError("The XMLNS namespace URI cannot be used.");
  }
}

function formatEncodedName(name: EncodedXmlName): string {
  return name.namespace
    ? JSON.stringify(`${name.namespace.prefix}:${name.localName}`)
    : JSON.stringify(name.localName);
}

function textElement(text: string): ParsedXmlElement {
  return { localName: "", attributes: [], children: [], text };
}

function propertyPath(property: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property)
    ? `.${property}`
    : `[${JSON.stringify(property)}]`;
}

function attributePath(attribute: string): string {
  return propertyPath(`@${attribute}`);
}

function expectXmlObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new XmlSerializationError(path, "Expected an object.");
  }
  return value as Record<string, unknown>;
}

function expectPlainXmlObject(value: unknown, path: string): Record<string, unknown> {
  const object = expectXmlObject(value, path);
  const prototype = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new XmlSerializationError(path, "Expected a plain object.");
  }
  return object;
}

function defineDataProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function asXmlSerializationError(error: unknown, path: string): XmlSerializationError {
  if (error instanceof XmlSerializationError) return error;
  if (error instanceof JsonSerializationError) {
    const prefix = `${error.path}: `;
    const message = error.message.startsWith(prefix)
      ? error.message.slice(prefix.length)
      : error.message;
    return new XmlSerializationError(error.path, message, { cause: error });
  }
  return new XmlSerializationError(path, error instanceof Error ? error.message : String(error), {
    cause: error,
  });
}

export const XmlCodecs = {
  scalar: scalarXmlCodec,
  array: arrayXmlCodec,
  record: recordXmlCodec,
  object: objectXmlCodec,
  lazy: lazyXmlCodec,
} as const;
