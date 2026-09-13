import { typescriptProperty, typescriptString } from "@typespex/compiler-core/unstable";
import { isSchemaRecord } from "./schema-utils.js";
import type { SchemaDocumentPlan } from "./types.js";

export function renderSchemaDocument(document: SchemaDocumentPlan): string {
  return `const schemaDocument = createSchemaDocument(${typescriptValue(document)});`;
}

export function renderSchemaReference(
  name: string,
  wireType: string,
  semanticType: string,
): string {
  const typeArguments =
    wireType === semanticType ? `<${semanticType}>` : `<${wireType}, ${semanticType}>`;
  return `schemaDocument.get${typeArguments}(${typescriptString(name)})`;
}

function typescriptValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(typescriptValue).join(", ")}]`;
  if (!isSchemaRecord(value)) return typescriptString(value);
  return `{ ${Object.entries(value)
    .map(
      ([name, item]) =>
        `${name === "__proto__" ? `[${typescriptString(name)}]` : typescriptProperty(name)}: ${typescriptValue(item)}`,
    )
    .join(", ")} }`;
}
