import type { ModelProperty, Program, Type } from "@typespec/compiler";
import { resolveEncodedName } from "@typespec/compiler";
import type { EmitterCtx } from "./ctx.js";
import { getAdditionalPropertiesValue, isNeverAdditionalProperties } from "./model-indexer.js";
import {
  getPayloadCollection,
  payloadItemProjection,
  payloadModelProperties,
  type PayloadProjection,
} from "./payload-context.js";

export const XML_MEDIA_TYPE = "application/xml";
const XML_ATTRIBUTE_STATE = Symbol.for("@typespec/xml/attribute");
const XML_UNWRAPPED_STATE = Symbol.for("@typespec/xml/unwrapped");
// This is the state key used by @typespec/xml's public getNs helper.
const XML_NAMESPACE_STATE = Symbol.for("@typespec/xml/nsDeclaration");

export interface XmlNamespaceMetadata {
  readonly prefix: string;
  readonly uri: string;
}

export function getXmlEncodedName(program: Program, target: Type & { name?: string }): string {
  if (!target.name) return "";
  return resolveEncodedName(program, target as Type & { name: string }, XML_MEDIA_TYPE);
}

export function isXmlAttribute(program: Program, target: ModelProperty): boolean {
  return program.stateSet(XML_ATTRIBUTE_STATE).has(target);
}

export function isXmlUnwrapped(program: Program, target: ModelProperty): boolean {
  return program.stateSet(XML_UNWRAPPED_STATE).has(target);
}

export function getXmlNamespace(program: Program, target: Type): XmlNamespaceMetadata | undefined {
  const namespace = program.stateMap(XML_NAMESPACE_STATE).get(target) as
    | { readonly namespace?: unknown; readonly prefix?: unknown }
    | undefined;
  return typeof namespace?.namespace === "string" && typeof namespace.prefix === "string"
    ? { prefix: namespace.prefix, uri: namespace.namespace }
    : undefined;
}

export function unsupportedXmlTypeReason(
  ctx: EmitterCtx,
  type: Type,
  projection?: PayloadProjection,
): string | undefined {
  if (!hasStableXmlRootName(type)) {
    return "anonymous XML bodies do not have a stable document root element name";
  }
  const rootName = xmlElementName(ctx.program, type);
  if (rootName && !isValidXmlLocalName(rootName)) {
    return `XML document root name ${JSON.stringify(rootName)} is not a valid unqualified XML name`;
  }
  const namespaces = new Map<string, string>();
  const rootNamespaceReason = registerXmlNamespace(namespaces, getXmlNamespace(ctx.program, type));
  if (rootNamespaceReason) return rootNamespaceReason;
  return unsupportedNestedXmlTypeReason(ctx, type, projection, new Set(), false, namespaces);
}

function unsupportedNestedXmlTypeReason(
  ctx: EmitterCtx,
  type: Type,
  projection: PayloadProjection | undefined,
  seen: ReadonlySet<Type>,
  elementNameRequired: boolean,
  namespaces: Map<string, string>,
): string | undefined {
  if (elementNameRequired) {
    if (!hasStableXmlRootName(type)) {
      return "anonymous XML array items do not have a stable element name";
    }
    const elementName = xmlElementName(ctx.program, type);
    if (elementName && !isValidXmlLocalName(elementName)) {
      return `XML array item name ${JSON.stringify(elementName)} is not a valid unqualified XML name`;
    }
    const namespaceReason = registerXmlNamespace(namespaces, getXmlNamespace(ctx.program, type));
    if (namespaceReason) return namespaceReason;
  }
  if (seen.has(type)) return undefined;
  const nextSeen = new Set(seen).add(type);

  if (isXmlLeafType(type, new Set())) return undefined;

  switch (type.kind) {
    case "Model": {
      const collection = getPayloadCollection(ctx, type);
      if (collection) {
        return unsupportedNestedXmlTypeReason(
          ctx,
          collection.value,
          payloadItemProjection(projection),
          nextSeen,
          collection.kind === "array",
          namespaces,
        );
      }

      let textProperties = 0;
      const attributeNames = new Set<string>();
      const elementNames = new Set<string>();
      for (const property of payloadModelProperties(type, projection)) {
        const attribute = isXmlAttribute(ctx.program, property);
        const unwrapped = isXmlUnwrapped(ctx.program, property);
        const propertyCollection =
          property.type.kind === "Model" ? getPayloadCollection(ctx, property.type) : undefined;
        if (attribute && unwrapped) {
          return `property ${JSON.stringify(property.name)} cannot be both an XML attribute and unwrapped`;
        }
        if (attribute && !isXmlLeafType(property.type, new Set())) {
          return `XML attribute ${JSON.stringify(property.name)} must have a scalar, literal, enum, or scalar-union type`;
        }
        if (unwrapped) {
          if (propertyCollection?.kind === "record") {
            return `unwrapped XML record property ${JSON.stringify(property.name)} is not supported`;
          }
          if (!propertyCollection && !isXmlLeafType(property.type, new Set())) {
            return `unwrapped XML property ${JSON.stringify(property.name)} must be a scalar value or array`;
          }
          if (!propertyCollection) textProperties += 1;
          if (!propertyCollection && getXmlNamespace(ctx.program, property)) {
            return `unwrapped XML text property ${JSON.stringify(property.name)} cannot declare a namespace`;
          }
        }
        if (!unwrapped || propertyCollection?.kind === "array") {
          const wireName = getXmlEncodedName(ctx.program, property);
          if (!isValidXmlLocalName(wireName)) {
            return `property ${JSON.stringify(property.name)} has invalid XML name ${JSON.stringify(wireName)}`;
          }
          const xmlNamespace = getXmlNamespace(ctx.program, property);
          if (attribute && wireName === "xmlns" && xmlNamespace === undefined) {
            return `XML attribute ${JSON.stringify(property.name)} cannot use the reserved name "xmlns"`;
          }
          const namespaceReason = registerXmlNamespace(namespaces, xmlNamespace);
          if (namespaceReason) {
            return `property ${JSON.stringify(property.name)}: ${namespaceReason}`;
          }
          const namespace = xmlNamespace?.uri ?? "";
          const key = `${namespace}\0${wireName}`;
          const names = attribute ? attributeNames : elementNames;
          if (names.has(key)) {
            return `multiple XML ${attribute ? "attributes" : "elements"} use name ${JSON.stringify(wireName)}`;
          }
          names.add(key);
        }
        const reason = unsupportedNestedXmlTypeReason(
          ctx,
          property.type,
          projection,
          nextSeen,
          false,
          namespaces,
        );
        if (reason) return `${JSON.stringify(property.name)}: ${reason}`;
      }
      if (textProperties > 1) return "an XML model can contain only one unwrapped text property";
      if (textProperties > 0 && elementNames.size > 0) {
        return "an XML model with unwrapped text cannot also contain child elements";
      }

      const additional = getAdditionalPropertiesValue(type);
      if (additional && !isNeverAdditionalProperties(type)) {
        if (textProperties > 0) {
          return "an XML model with unwrapped text cannot also contain additional properties";
        }
        return unsupportedNestedXmlTypeReason(
          ctx,
          additional,
          payloadItemProjection(projection),
          nextSeen,
          false,
          namespaces,
        );
      }
      return undefined;
    }
    case "Union":
      return "XML unions may contain only scalar, literal, or enum variants";
    case "Tuple":
      return "XML tuple bodies are not supported";
    case "Intrinsic":
      return `TypeSpec intrinsic ${JSON.stringify(type.name)} has no XML representation`;
    case "ModelProperty":
    case "UnionVariant":
      return unsupportedNestedXmlTypeReason(
        ctx,
        type.type,
        projection,
        nextSeen,
        elementNameRequired,
        namespaces,
      );
    default:
      return `TypeSpec ${type.kind} values have no XML representation`;
  }
}

export function isXmlLeafType(type: Type, seen: ReadonlySet<Type>): boolean {
  if (seen.has(type)) return false;
  const nextSeen = new Set(seen).add(type);
  switch (type.kind) {
    case "Scalar":
    case "Enum":
    case "String":
    case "StringTemplate":
    case "Number":
    case "Boolean":
      return true;
    case "Union":
      return (
        type.variants.size > 0 &&
        [...type.variants.values()].every((variant) => isXmlLeafType(variant.type, nextSeen))
      );
    case "ModelProperty":
    case "UnionVariant":
      return isXmlLeafType(type.type, nextSeen);
    default:
      return false;
  }
}

function hasStableXmlRootName(type: Type): boolean {
  switch (type.kind) {
    case "Model":
    case "Union":
      return (type.name?.length ?? 0) > 0;
    case "Scalar":
    case "Enum":
      return type.name.length > 0;
    case "ModelProperty":
    case "UnionVariant":
      return hasStableXmlRootName(type.type);
    case "String":
    case "StringTemplate":
    case "Number":
    case "Boolean":
      return true;
    default:
      return false;
  }
}

function xmlElementName(program: Program, type: Type): string | undefined {
  switch (type.kind) {
    case "Model":
    case "Union":
      return type.name ? getXmlEncodedName(program, type) : undefined;
    case "Scalar":
    case "Enum":
      return getXmlEncodedName(program, type);
    case "String":
    case "StringTemplate":
      return "string";
    case "Number":
      return "number";
    case "Boolean":
      return "boolean";
    case "ModelProperty":
    case "UnionVariant":
      return xmlElementName(program, type.type);
    default:
      return undefined;
  }
}

function isValidXmlLocalName(name: string): boolean {
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

function invalidXmlNamespaceReason(
  namespace: XmlNamespaceMetadata | undefined,
): string | undefined {
  if (!namespace) return undefined;
  if (!isValidXmlLocalName(namespace.prefix)) {
    return `XML namespace prefix ${JSON.stringify(namespace.prefix)} is not a valid unqualified XML name`;
  }
  if (namespace.prefix === "xmlns")
    return 'the reserved XML namespace prefix "xmlns" cannot be used';
  if (namespace.prefix === "xml" && namespace.uri !== "http://www.w3.org/XML/1998/namespace") {
    return 'the reserved XML namespace prefix "xml" must use its standard namespace URI';
  }
  if (namespace.prefix !== "xml" && namespace.uri === "http://www.w3.org/XML/1998/namespace") {
    return 'only the reserved XML namespace prefix "xml" may use its standard namespace URI';
  }
  if (namespace.uri === "http://www.w3.org/2000/xmlns/") {
    return "the reserved XMLNS namespace URI cannot be used";
  }
  return undefined;
}

function registerXmlNamespace(
  namespaces: Map<string, string>,
  namespace: XmlNamespaceMetadata | undefined,
): string | undefined {
  const invalidReason = invalidXmlNamespaceReason(namespace);
  if (invalidReason || !namespace) return invalidReason;
  const existing = namespaces.get(namespace.prefix);
  if (existing !== undefined && existing !== namespace.uri) {
    return `XML namespace prefix ${JSON.stringify(namespace.prefix)} maps to conflicting namespace URIs`;
  }
  namespaces.set(namespace.prefix, namespace.uri);
  return undefined;
}
