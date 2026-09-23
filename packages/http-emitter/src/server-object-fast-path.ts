import type { ModelProperty } from "@typespec/compiler";
import type { EmitterCtx } from "./ctx.js";
import { getJsonPropertyWireName } from "./json-wire-transforms.js";
import { payloadPropertyOptional, type PayloadProjection } from "./payload-context.js";
import { emitStrictScalarGuard } from "./server-scalar-fast-path.js";
import { tsLiteral, tsObjectKey } from "./typescript-names.js";

/** Emit sequential reads and checks, allocating decoder results only on failure. */
export function emitFlatJsonObjectDecoder(
  ctx: EmitterCtx,
  properties: readonly ModelProperty[],
  projection: PayloadProjection | undefined,
  fallback: (property: ModelProperty) => string,
  typeTs: string,
): string | undefined {
  // Keep trivial schemas compact; specialize where multiple field dispatches
  // and intermediate results can be removed.
  if (properties.length < 2) return undefined;
  // Object.entries reorders integer property names in the generic decoder.
  if (properties.some((property) => /^(0|[1-9]\d*)$/.test(property.name))) return undefined;
  const declarations: string[] = [];
  const fields = properties.map((property, index) => {
    const value = `value${index}`;
    return {
      property,
      value,
      wireName: getJsonPropertyWireName(ctx, property),
      optional: payloadPropertyOptional(property, projection),
      guard: emitStrictScalarGuard(ctx, property, value, declarations),
    };
  });
  if (fields.some((field) => field.guard === undefined)) return undefined;
  // Keep the generic decoder's duplicate-wire-name rejection at initialization.
  if (new Set(fields.map((field) => field.wireName)).size !== fields.length) return undefined;

  const reads = fields.map(({ property, value, wireName, optional, guard }, index) => {
    const decoder = fallback(property);
    declarations.push(
      `const fallback${index} = ${optional ? `Decoders.optional(${decoder})` : decoder};`,
    );
    return `let ${value} = Object.prototype.hasOwnProperty.call(source, ${tsLiteral(wireName)})
      ? source[${tsLiteral(wireName)}] : undefined;
    if (!(${optional ? `${value} === undefined || (` : ""}${guard}${optional ? ")" : ""})) {
      const decoded = fallback${index}.decode(${value});
      if (decoded._tag === "Left") {
        for (const issue of decoded.left) {
          (issues ??= []).push({ path: ${tsLiteral(`.${wireName}`)} + issue.path, message: issue.message });
        }
      } else ${value} = decoded.right;
    }`;
  });
  const full = `{ ${fields.map(({ property, value }) => `${tsObjectKey(property.name)}: ${value}`).join(", ")} }`;
  const optionalFields = fields.filter((field) => field.optional);
  const partial = `{ ${fields
    .filter((field) => optionalFields.length !== 1 || !field.optional)
    .map(({ property, value, optional }) => {
      const entry = `${tsObjectKey(property.name)}: ${value}`;
      return optional ? `...(${value} === undefined ? {} : { ${entry} })` : entry;
    })
    .join(", ")} }`;
  const result =
    optionalFields.length === 0
      ? full
      : `${optionalFields.map(({ value }) => `${value} !== undefined`).join(" && ")} ? ${full} : ${partial}`;
  // Do not retry the whole object on failure: getters and proxies must be read
  // once, with each field validated before reading the next one.
  return `(() => {
    ${declarations.join("\n")}
    return Decoder.of<${typeTs}>((input) => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return Either.left([{ path: "", message: "Expected an object." }]);
      }
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) {
        return Either.left([{ path: "", message: "Expected a plain object." }]);
      }
      const source = input as Record<string, unknown>;
      let issues: { path: string; message: string }[] | undefined;
      ${reads.join("\n")}
      return issues ? Either.left(issues) : Either.right((${result}) as ${typeTs});
    });
  })()`;
}
