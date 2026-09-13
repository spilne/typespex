import type { ValueCodecSpec } from "@typespex/codec";

/** Visit reachable codec nodes once, without interpreting defaults or schemas as codecs. */
export function* reachableCodecSpecs(
  root: ValueCodecSpec,
  definitions: Readonly<Record<string, ValueCodecSpec>> = {},
): Iterable<ValueCodecSpec> {
  const pending = [root];
  const seen = new Set<ValueCodecSpec>();
  while (pending.length > 0) {
    const spec = pending.pop()!;
    if (seen.has(spec)) continue;
    seen.add(spec);
    yield spec;
    switch (spec.kind) {
      case "ref":
        if (Object.hasOwn(definitions, spec.name)) pending.push(definitions[spec.name]!);
        break;
      case "array":
        pending.push(spec.item);
        break;
      case "tuple":
        pending.push(...spec.items);
        break;
      case "union":
        pending.push(...spec.variants);
        break;
      case "object":
        pending.push(...Object.values(spec.properties).map((property) => property.codec));
        if (spec.additionalProperties && spec.additionalProperties !== true)
          pending.push(spec.additionalProperties);
        break;
    }
  }
}
