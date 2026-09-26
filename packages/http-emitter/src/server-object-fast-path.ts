import type { Model, ModelProperty, Type } from "@typespec/compiler";
import type { EmitterCtx } from "./ctx.js";
import { getJsonPropertyWireName } from "./json-wire-transforms.js";
import { enumMemberLiteralExpression, resolveNumericLiteral } from "./numeric-literals.js";
import {
  getPayloadCollection,
  payloadItemProjection,
  payloadPropertyOptional,
  type PayloadProjection,
} from "./payload-context.js";
import { emitStrictScalarTypeGuard } from "./server-scalar-fast-path.js";
import { getStringLiteralValue, isStringLikeLiteral } from "./string-template-literals.js";
import { tsLiteral, tsObjectKey } from "./typescript-names.js";
import { getValidationRules } from "./validation-emission.js";

/** How one JSON value is checked in place. */
type ValueCheck =
  /** A boolean expression over the value, which is then its own result. */
  | { readonly kind: "guard"; readonly guard: string; readonly fallback: string }
  /** A hoisted decoder whose result replaces the value. */
  | { readonly kind: "decoder"; readonly decoder: string }
  /** An array whose elements are checked in place, one read each. */
  | {
      readonly kind: "array";
      readonly element: ValueCheck;
      readonly fallback: string;
      readonly lengthConditions: readonly string[];
    };

/** The generic decoders that in-place checks report through on failure. */
export interface ObjectFastPathEmitters {
  /** The decoder for one property. */
  readonly property: (property: ModelProperty) => string;
  /** The decoder for a payload type, encoded as the given property when set. */
  readonly type: (
    type: Type,
    projection: PayloadProjection | undefined,
    encodingTarget: ModelProperty | undefined,
  ) => string;
  /** The decoder for an array type around an element decoder expression. */
  readonly array: (type: Model, target: ModelProperty | undefined, element: string) => string;
}

/** Declarations hoisted out of one generated decoder, named by role. */
interface HoistScope {
  readonly declarations: string[];
  readonly counts: { decoder: number; fallback: number };
}

/**
 * Emit sequential reads and checks for a JSON object. Scalars, literals, and
 * enums are checked in place, nested objects call their own generated decoder,
 * and arrays are walked with their elements checked in place. Every input
 * property and element is read exactly once, in declaration order, and any
 * failed check reports through the generic decoder for that value, so
 * diagnostics stay identical to the generic decoders.
 */
export function emitFlatJsonObjectDecoder(
  ctx: EmitterCtx,
  properties: readonly ModelProperty[],
  projection: PayloadProjection | undefined,
  emitters: ObjectFastPathEmitters,
  typeTs: string,
): string | undefined {
  // Keep trivial schemas compact; specialize where multiple field dispatches
  // and intermediate results can be removed.
  if (properties.length < 2) return undefined;
  // Object.entries reorders integer property names in the generic decoder.
  if (properties.some((property) => /^(0|[1-9]\d*)$/.test(property.name))) return undefined;
  const wireNames = properties.map((property) => getJsonPropertyWireName(ctx, property));
  // Keep the generic decoder's duplicate-wire-name rejection at initialization.
  if (new Set(wireNames).size !== wireNames.length) return undefined;

  const scope: HoistScope = { declarations: [], counts: { decoder: 0, fallback: 0 } };
  const reads = properties.map((property, index) => {
    const value = `value${index}`;
    const wireName = wireNames[index]!;
    const check = typeCheck(
      ctx,
      property.type,
      property,
      property,
      projection,
      emitters,
      scope,
      value,
    );
    const body = emitValueCheck(check, value, tsLiteral(`.${wireName}`));
    const read = `let ${value} = Object.prototype.hasOwnProperty.call(source, ${tsLiteral(wireName)})
      ? source[${tsLiteral(wireName)}] : undefined;`;
    // Absent optional values are neither checked nor emitted.
    return payloadPropertyOptional(property, projection)
      ? `${read}\nif (${value} !== undefined) {\n${body}\n}`
      : `${read}\n${body}`;
  });
  const fields = properties.map((property, index) => ({
    property,
    value: `value${index}`,
    optional: payloadPropertyOptional(property, projection),
  }));
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
    ${scope.declarations.join("\n")}
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

/** Hoists a decoder expression into a named constant and returns its name. */
function hoist(scope: HoistScope, role: "decoder" | "fallback", expression: string): string {
  const name = `${role}${scope.counts[role]++}`;
  scope.declarations.push(`const ${name} = ${expression};`);
  return name;
}

/** The generic decoder a check reports through, which also decodes its value. */
function genericDecoder(check: ValueCheck): string {
  return check.kind === "decoder" ? check.decoder : check.fallback;
}

/**
 * Emits the statements that check `value` in place. On failure the generic
 * decoder produces the issues, which are recorded under `pathExpression`; on
 * success `value` holds the decoded result.
 */
function emitValueCheck(check: ValueCheck, value: string, pathExpression: string): string {
  const decode = (decoder: string) => `const decoded = ${decoder}.decode(${value});
      if (decoded._tag === "Left") {
        for (const issue of decoded.left) {
          (issues ??= []).push({ path: ${pathExpression} + issue.path, message: issue.message });
        }
      } else ${value} = decoded.right;`;
  switch (check.kind) {
    case "guard":
      return `if (!(${check.guard})) {\n${decode(check.fallback)}\n}`;
    case "decoder":
      return `{\n${decode(check.decoder)}\n}`;
    case "array": {
      const element = `${value}Item`;
      const index = `${value}Index`;
      const output = `${value}Items`;
      const conditions = [`Array.isArray(${value})`, ...check.lengthConditions];
      return `if (!(${conditions.join(" && ")})) {
      ${decode(check.fallback)}
    } else {
      const ${output}: unknown[] = new Array(${value}.length);
      for (let ${index} = 0; ${index} < ${value}.length; ${index}++) {
        let ${element} = ${value}[${index}];
        ${emitValueCheck(check.element, element, `${pathExpression} + "[" + ${index} + "]"`)}
        ${output}[${index}] = ${element};
      }
      ${value} = ${output};
    }`;
    }
  }
}

/**
 * Chooses how a value of `type` is checked. `target` is the property whose
 * validation rules apply; `encodingTarget` is the property whose encoding
 * applies, which the generic decoders carry into array elements.
 */
function typeCheck(
  ctx: EmitterCtx,
  type: Type,
  target: ModelProperty | undefined,
  encodingTarget: ModelProperty | undefined,
  projection: PayloadProjection | undefined,
  emitters: ObjectFastPathEmitters,
  scope: HoistScope,
  value: string,
): ValueCheck {
  const generic = () =>
    target ? emitters.property(target) : emitters.type(type, projection, encodingTarget);
  const decoder = (): ValueCheck => ({
    kind: "decoder",
    decoder: hoist(scope, "decoder", generic()),
  });
  const guarded = (guard: string | undefined): ValueCheck =>
    guard === undefined
      ? decoder()
      : { kind: "guard", guard, fallback: hoist(scope, "fallback", generic()) };
  switch (type.kind) {
    case "Scalar":
      return guarded(
        emitStrictScalarTypeGuard(ctx, type, target, encodingTarget, value, scope.declarations),
      );
    case "String":
    case "StringTemplate":
    case "Number":
    case "Boolean":
    case "Enum":
    case "EnumMember":
    case "Intrinsic":
      return guarded(literalGuard(ctx, type, value));
    case "Union": {
      const guards: string[] = [];
      for (const variant of type.variants.values()) {
        const guard = literalGuard(ctx, variant.type, value);
        if (guard === undefined) return decoder();
        guards.push(guard);
      }
      return guards.length === 0 ? decoder() : guarded(guards.join(" || "));
    }
    case "Model": {
      const collection = getPayloadCollection(ctx, type);
      if (collection?.kind !== "array") return decoder();
      const lengthConditions: string[] = [];
      for (const rule of [
        ...getValidationRules(ctx, type, "array"),
        ...(target ? getValidationRules(ctx, target, "array") : []),
      ]) {
        if (rule.kind === "minItems") lengthConditions.push(`${value}.length >= ${rule.argument}`);
        else if (rule.kind === "maxItems")
          lengthConditions.push(`${value}.length <= ${rule.argument}`);
        else return decoder();
      }
      const element = typeCheck(
        ctx,
        collection.value,
        undefined,
        encodingTarget,
        payloadItemProjection(projection),
        emitters,
        scope,
        `${value}Item`,
      );
      return {
        kind: "array",
        element,
        fallback: hoist(scope, "fallback", emitters.array(type, target, genericDecoder(element))),
        lengthConditions,
      };
    }
    default:
      return decoder();
  }
}

/** An equality guard for a literal, enum member, or whole enum in strict JSON mode. */
function literalGuard(ctx: EmitterCtx, type: Type, value: string): string | undefined {
  switch (type.kind) {
    case "String":
    case "StringTemplate": {
      if (!isStringLikeLiteral(type)) return undefined;
      const literal = getStringLiteralValue(type);
      return literal === undefined ? undefined : `${value} === ${tsLiteral(literal)}`;
    }
    case "Number": {
      const literal = resolveNumericLiteral(type);
      return literal.supported && literal.kind === "number"
        ? `${value} === ${literal.expression}`
        : undefined;
    }
    case "Boolean":
      return `${value} === ${String(type.value)}`;
    case "Intrinsic":
      return type.name === "null" ? `${value} === null` : undefined;
    case "EnumMember":
      return `${value} === ${enumMemberLiteralExpression(ctx.program, type)}`;
    case "Enum": {
      const members = [...type.members.values()].map(
        (member) => `${value} === ${enumMemberLiteralExpression(ctx.program, member)}`,
      );
      return members.length === 0 ? undefined : members.join(" || ");
    }
    default:
      return undefined;
  }
}
