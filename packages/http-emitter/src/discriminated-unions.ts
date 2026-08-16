import type { DiscriminatedUnion, Program, Type, Union, UnionVariant } from "@typespec/compiler";
import { discriminatedDecorator, getDiscriminatedUnion } from "@typespec/compiler";
import { tsLiteral, tsPropertyDeclaration } from "./typescript-names.js";

export interface DiscriminatedVariant {
  /** Undefined identifies the union's unnamed default variant. */
  readonly tag?: string;
  readonly type: Type;
  readonly variant: UnionVariant;
}

/** Resolve the standard-library `@discriminated` contract for a union. */
export function resolveDiscriminatedUnion(
  program: Program,
  union: Union,
): DiscriminatedUnion | undefined {
  const resolved = getDiscriminatedUnion(program, union)[0];
  if (resolved) return resolved;

  // Decorators on template declarations execute only for concrete instances,
  // but models.ts must still emit the generic declaration in its wire shape.
  const application = union.decorators.find(
    (decorator) => decorator.decorator === discriminatedDecorator,
  );
  if (!application) return undefined;

  const supplied = application.args[0]?.jsValue;
  const options =
    typeof supplied === "object" && supplied !== null && !Array.isArray(supplied)
      ? (supplied as Record<string, unknown>)
      : {};
  const variants = new Map<string, Type>();
  let defaultVariant: Type | undefined;
  for (const variant of union.variants.values()) {
    if (typeof variant.name === "string") {
      variants.set(variant.name, variant.type);
    } else {
      defaultVariant = variant.type;
    }
  }

  return {
    type: union,
    options: {
      envelope: options.envelope === "none" ? "none" : "object",
      discriminatorPropertyName:
        typeof options.discriminatorPropertyName === "string"
          ? options.discriminatorPropertyName
          : "kind",
      envelopePropertyName:
        typeof options.envelopePropertyName === "string" ? options.envelopePropertyName : "value",
    },
    variants,
    defaultVariant,
  };
}

/** Variants in source order, including the optional unnamed default variant. */
export function discriminatedVariants(
  discriminated: DiscriminatedUnion,
): readonly DiscriminatedVariant[] {
  return [...discriminated.type.variants.values()].map((variant) => ({
    tag: typeof variant.name === "string" ? variant.name : undefined,
    type: variant.type,
    variant,
  }));
}

/** Render the complete handler-facing union body for either envelope mode. */
export function discriminatedUnionBodyToTs(
  discriminated: DiscriminatedUnion,
  renderPayload: (variant: DiscriminatedVariant) => string,
): string {
  const variants = discriminatedVariants(discriminated).map((variant) =>
    discriminatedVariantToTs(discriminated, variant, renderPayload(variant)),
  );
  return variants.length > 0 ? variants.join(" | ") : "never";
}

/** Render one synthetic envelope or inline-discriminator variant. */
export function discriminatedVariantToTs(
  discriminated: DiscriminatedUnion,
  variant: Pick<DiscriminatedVariant, "tag">,
  payloadType: string,
): string {
  const discriminatorType = variant.tag === undefined ? "string" : tsLiteral(variant.tag);
  const discriminator = tsPropertyDeclaration(
    discriminated.options.discriminatorPropertyName,
    discriminatorType,
  );

  if (discriminated.options.envelope === "none") {
    return `({ ${discriminator} } & (${payloadType}))`;
  }

  const envelope = tsPropertyDeclaration(discriminated.options.envelopePropertyName, payloadType);
  return `{ ${discriminator}; ${envelope} }`;
}
