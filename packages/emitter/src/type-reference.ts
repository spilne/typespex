import type { Type, Model } from "@typespec/compiler";
import { isArrayModelType, isRecordModelType } from "@typespec/compiler";
import type { EmitterCtx } from "./ctx.js";
import { scalarToTs } from "./scalar-map.js";

/**
 * Convert a TypeSpec type to a TypeScript type string.
 */
export function typeToTs(ctx: EmitterCtx, type: Type): string {
  switch (type.kind) {
    case "Scalar":
      return scalarToTs(type);

    case "Model": {
      if (isArrayModelType(ctx.program, type)) {
        const elementType = type.indexer!.value;
        return `${typeToTs(ctx, elementType)}[]`;
      }
      if (isRecordModelType(ctx.program, type)) {
        const valueType = type.indexer!.value;
        return `Record<string, ${typeToTs(ctx, valueType)}>`;
      }
      // Unwrap HttpPart<T> → T
      if (type.name === "HttpPart" && type.templateMapper?.args) {
        const inner = [...type.templateMapper.args][0];
        if (inner) return typeToTs(ctx, inner as Type);
      }
      // Map File and subtypes → Web standard File
      if (isFileModel(type)) {
        return "File";
      }
      if (type.name === "" || type.name === undefined) {
        return emitInlineModel(ctx, type);
      }
      return type.name;
    }

    case "Union": {
      const variants = [...type.variants.values()];
      const parts = variants.map((v) => typeToTs(ctx, v.type));
      return parts.join(" | ");
    }

    case "Enum": {
      const members = [...type.members.values()];
      return members
        .map((m) =>
          typeof m.value === "string"
            ? JSON.stringify(m.value)
            : m.value != null
              ? String(m.value)
              : JSON.stringify(m.name),
        )
        .join(" | ");
    }

    case "String":
      return JSON.stringify(type.value);

    case "Number":
      return String(type.value);

    case "Boolean":
      return String(type.value);

    case "Intrinsic":
      switch (type.name) {
        case "void":
          return "void";
        case "null":
          return "null";
        case "never":
          return "never";
        case "unknown":
          return "unknown";
        default:
          return "unknown";
      }

    case "Tuple":
      return `[${type.values.map((v) => typeToTs(ctx, v)).join(", ")}]`;

    case "UnionVariant":
      return typeToTs(ctx, type.type);

    case "ModelProperty":
      return typeToTs(ctx, type.type);

    default:
      return "unknown";
  }
}

function isFileModel(model: Model): boolean {
  let current: Model | undefined = model;
  while (current) {
    if (current.name === "File") return true;
    current = current.baseModel;
  }
  return false;
}

function emitInlineModel(ctx: EmitterCtx, model: Model): string {
  const props = [...model.properties.values()].map((prop) => {
    const optional = prop.optional ? "?" : "";
    return `${prop.name}${optional}: ${typeToTs(ctx, prop.type)}`;
  });
  return `{ ${props.join("; ")} }`;
}
