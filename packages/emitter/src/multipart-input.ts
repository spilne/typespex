import type { HttpOperationMultipartBody, HttpOperationPart } from "@typespec/http";
import type { EmitterCtx } from "./ctx.js";
import { typeToTs } from "./type-reference.js";
import { tsPropertyDeclaration } from "./typescript-names.js";

type HttpOperationMultipartBodyModel = Extract<
  HttpOperationMultipartBody,
  { readonly multipartKind: "model" }
>;

/** Source-level handler value represented by one resolved multipart part. */
export function multipartPartTypeToTs(ctx: EmitterCtx, part: HttpOperationPart): string {
  const itemType = typeToTs(ctx, part.body.type);
  return part.multi ? arrayTypeToTs(itemType) : itemType;
}

/**
 * Builds the handler-visible multipart body shape.
 *
 * Model multipart bodies use source property names, which can differ from the
 * MIME part names. Tuple bodies stay ordered and retain unnamed entries.
 */
export function multipartBodyTypeToTs(
  ctx: EmitterCtx,
  body: HttpOperationMultipartBody,
  allModelPropertiesOptional = false,
): string {
  if (body.multipartKind === "tuple") {
    const entries = body.parts.map((part) => {
      const valueType = multipartPartTypeToTs(ctx, part);
      return part.optional ? `${valueType} | undefined` : valueType;
    });
    return `[${entries.join(", ")}]`;
  }

  const properties = multipartModelPropertyDeclarations(ctx, body, allModelPropertiesOptional);
  return properties.length > 0 ? `{ ${properties.join("; ")} }` : "Record<string, never>";
}

/** Property declarations for a flattened model-form multipart body. */
export function multipartModelPropertyDeclarations(
  ctx: EmitterCtx,
  body: HttpOperationMultipartBodyModel,
  allOptional = false,
): readonly string[] {
  return body.parts.map((part) =>
    tsPropertyDeclaration(part.property.name, multipartPartTypeToTs(ctx, part), {
      optional: allOptional || part.optional,
    }),
  );
}

/**
 * Source property names that can be flattened beside request metadata.
 * Ordered tuple bodies are deliberately non-flattenable.
 */
export function multipartFlattenedPropertyNames(
  body: HttpOperationMultipartBody,
): readonly string[] | undefined {
  return body.multipartKind === "model" ? body.parts.map((part) => part.property.name) : undefined;
}

function arrayTypeToTs(elementType: string): string {
  const trimmed = elementType.trim();
  return /[|&?]/.test(trimmed) ? `(${trimmed})[]` : `${trimmed}[]`;
}
