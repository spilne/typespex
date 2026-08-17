// Schema-aware multipart validation and wire-value construction.
import { isLeft } from "../core/either.js";
import { createFile } from "./file.js";
import { isContentTypeAccepted } from "./media-type.js";
import {
  type ParsedMultipartBody,
  type ParsedMultipartPart,
  MultipartSyntaxError,
  parseMultipartRequest,
  validateFileName,
} from "./multipart.js";
import { appendBodyField, defineDataProperty } from "./object-properties.js";
import { parseJsonText } from "./json-value.js";
import {
  Decoder,
  type DecoderResult,
  fail,
  failMany,
  prefixIssues,
  succeed,
  traverseEither,
} from "./value-decoder.js";
import type { ValidationIssue } from "./validation.js";

// ---------------------------------------------------------------------------
// Schema-aware multipart decoders
// ---------------------------------------------------------------------------

export type MultipartPartKind = "text" | "binary" | "json" | "file";

export type MultipartPartDecoderMap<A = unknown> = Readonly<
  Partial<Record<MultipartPartKind, Decoder<A>>>
>;

interface MultipartPartDescriptorOptions {
  /** Allowed media types for this part. Parameters are ignored during matching. */
  readonly contentTypes?: readonly string[];
  /** Reject a part that omits Content-Type. */
  readonly requireContentType?: boolean;
  /** The part may be omitted. */
  readonly optional?: boolean;
  /** The part may occur more than once and is returned as an array. */
  readonly multi?: boolean;
  /** Wire Content-Disposition name. Required for named bodies and form-data tuples. */
  readonly name?: string;
  /** Handler property name. Required for named bodies and omitted for tuples. */
  readonly property?: string;
  /**
   * For File parts, relocate File.name to this per-part header. When set,
   * Content-Disposition's filename parameter is intentionally ignored.
   */
  readonly fileNameHeader?: string;
  /** Reject a File part when its selected filename metadata is absent. */
  readonly requireFileName?: boolean;
}

/** Schema for one logical multipart field or tuple element. */
export type MultipartPartDescriptor<A = unknown> = MultipartPartDescriptorOptions &
  (
    | {
        /** Parser used for one homogeneous wire representation. */
        readonly kind: MultipartPartKind;
        readonly decoder: Decoder<A>;
        readonly decoders?: never;
      }
    | {
        /** Parsers selected from the received per-part Content-Type. */
        readonly decoders: MultipartPartDecoderMap<A>;
        readonly kind?: never;
        readonly decoder?: never;
      }
  );

type MultipartOptionalDescriptorFlag<Value> = undefined extends Value
  ? { readonly optional: true }
  : { readonly optional?: false };

// An array-valued property can be one array payload or repeated item payloads;
// the descriptor's multi flag selects which interpretation applies.
type MultipartDescriptorForValue<Value> =
  | (MultipartPartDescriptor<Exclude<Value, undefined>> & {
      readonly multi?: false;
    } & MultipartOptionalDescriptorFlag<Value>)
  | (Exclude<Value, undefined> extends readonly (infer Item)[]
      ? MultipartPartDescriptor<Item> & {
          readonly multi: true;
        } & MultipartOptionalDescriptorFlag<Value>
      : never);

/** Descriptor union keyed by the handler properties of one named multipart body. */
export type MultipartFormDataDescriptor<A extends object> = {
  [Key in Extract<keyof A, string>]-?: MultipartDescriptorForValue<A[Key]> & {
    readonly name: string;
    readonly property: Key;
  };
}[Extract<keyof A, string>];

/** Positional descriptors corresponding to one multipart tuple handler value. */
export type MultipartTupleDescriptors<A extends readonly unknown[]> = {
  readonly [Key in keyof A]: MultipartDescriptorForValue<A[Key]> & {
    readonly property?: never;
  };
};

type MultipartSchemaMode = "form-data" | "tuple";

const MULTIPART_BODY = Symbol("typespex.multipart.body");
const MULTIPART_PART_KINDS: readonly MultipartPartKind[] = ["text", "binary", "json", "file"];
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

type MultipartDecoderInput = Record<string, unknown> & {
  readonly [MULTIPART_BODY]: ParsedMultipartBody;
};

class MultipartSchemaDecoder<A> extends Decoder<A> {
  constructor(
    private readonly mode: MultipartSchemaMode,
    private readonly parts: readonly MultipartPartDescriptor[],
  ) {
    super();
  }

  decode(input: unknown): DecoderResult<A> {
    const body = getParsedMultipartBody(input);
    if (!body) return fail("", "Expected a parsed multipart body.");
    const schemaIssues = validateMultipartSchema(this.mode, this.parts);
    if (schemaIssues.length > 0) return failMany(schemaIssues);
    return (
      this.mode === "form-data"
        ? decodeMultipartFormData(this.parts, body)
        : decodeMultipartTuple(this.parts, body)
    ) as DecoderResult<A>;
  }
}

/**
 * Builds a schema-aware decoder for named multipart fields.
 *
 * Generated descriptors provide both `name` (wire name) and `property`
 * (handler property), which need not be equal. This supports form-data and
 * named model bodies carried by other multipart subtypes.
 */
function multipartFormDataDecoder<A extends object>(
  parts: readonly MultipartFormDataDescriptor<A>[],
): Decoder<A> {
  return new MultipartSchemaDecoder("form-data", parts as readonly MultipartPartDescriptor[]);
}

/** Builds a schema-aware decoder for ordered multipart tuple parts. */
function multipartTupleDecoder<A extends readonly unknown[]>(
  parts: MultipartTupleDescriptors<A>,
): Decoder<A> {
  return new MultipartSchemaDecoder("tuple", parts as readonly MultipartPartDescriptor[]);
}

function getParsedMultipartBody(input: unknown): ParsedMultipartBody | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  return (input as Partial<MultipartDecoderInput>)[MULTIPART_BODY];
}

function validateMultipartSchema(
  mode: MultipartSchemaMode,
  descriptors: readonly MultipartPartDescriptor[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const names = new Set<string>();
  const properties = new Set<string>();
  if (descriptors.length > 256) {
    issues.push({ path: "", message: "Multipart schema exceeds the 256-part limit." });
    return issues;
  }

  for (let index = 0; index < descriptors.length; index++) {
    const descriptor = descriptors[index]!;
    const path = mode === "tuple" ? `[${index}]` : "";
    const decoders = descriptorDecoders(descriptor);
    if (availableMultipartPartKinds(decoders).length === 0) {
      issues.push({ path, message: "Multipart part has no decoder." });
    }
    if (descriptor.fileNameHeader !== undefined) {
      if (!isHeaderName(descriptor.fileNameHeader)) {
        issues.push({ path, message: "Multipart filename header name is invalid." });
      }
      if (!decoders.file) {
        issues.push({
          path,
          message: "Multipart filename metadata may only be used with a File decoder.",
        });
      }
    }
    if (descriptor.requireFileName && !decoders.file) {
      issues.push({
        path,
        message: "Required filename metadata may only be used with a File decoder.",
      });
    }

    if (mode === "form-data") {
      if (!descriptor.name || !descriptor.property) {
        issues.push({
          path,
          message: "Named multipart parts require wire and handler property names.",
        });
        continue;
      }
      if (names.has(descriptor.name)) {
        issues.push({ path: `.${descriptor.property}`, message: "Duplicate multipart wire name." });
      }
      if (properties.has(descriptor.property)) {
        issues.push({
          path: `.${descriptor.property}`,
          message: "Duplicate multipart handler property.",
        });
      }
      names.add(descriptor.name);
      properties.add(descriptor.property);
    } else if (descriptor.property !== undefined) {
      issues.push({
        path,
        message: "Ordered multipart tuple parts must not declare handler properties.",
      });
    }
  }
  return issues;
}

function decodeMultipartFormData(
  descriptors: readonly MultipartPartDescriptor[],
  body: ParsedMultipartBody,
): DecoderResult<Record<string, unknown>> {
  const byName = new Map<string, ParsedMultipartPart[]>();
  const issues: ValidationIssue[] = [];
  for (let index = 0; index < body.parts.length; index++) {
    const part = body.parts[index]!;
    const disposition = part.disposition;
    if (
      !disposition?.name ||
      (body.mediaType === "multipart/form-data" && disposition.type !== "form-data")
    ) {
      issues.push({
        path: `[${index}]`,
        message:
          body.mediaType === "multipart/form-data"
            ? "Named form-data parts require Content-Disposition: form-data with a name."
            : "Named multipart parts require Content-Disposition with a name.",
      });
      continue;
    }
    const values = byName.get(disposition.name);
    if (values) values.push(part);
    else byName.set(disposition.name, [part]);
  }

  const knownNames = new Set(descriptors.map((part) => part.name!));
  for (const name of byName.keys()) {
    if (!knownNames.has(name)) {
      issues.push({ path: `.${name}`, message: "Unexpected multipart part." });
    }
  }

  const output: Record<string, unknown> = {};
  for (const descriptor of descriptors) {
    const property = descriptor.property!;
    const values = byName.get(descriptor.name!) ?? [];
    const cardinality = validateNamedPartCardinality(descriptor, values.length, property);
    if (cardinality) {
      issues.push(cardinality);
      continue;
    }
    if (values.length === 0) continue;

    if (descriptor.multi) {
      const decoded = traverseEither(values, (part, index) =>
        prefixIssues(decodeMultipartPart(descriptor, part), `.${property}[${index}]`),
      );
      if (isLeft(decoded)) issues.push(...decoded.left);
      else defineDataProperty(output, property, decoded.right);
    } else {
      const decoded = prefixIssues(decodeMultipartPart(descriptor, values[0]!), `.${property}`);
      if (isLeft(decoded)) issues.push(...decoded.left);
      else defineDataProperty(output, property, decoded.right);
    }
  }

  return issues.length > 0 ? failMany(issues) : succeed(output);
}

function validateNamedPartCardinality(
  descriptor: MultipartPartDescriptor,
  count: number,
  property: string,
): ValidationIssue | undefined {
  if (count === 0 && !descriptor.optional) {
    return { path: `.${property}`, message: "Required multipart part is missing." };
  }
  if (!descriptor.multi && count > 1) {
    return { path: `.${property}`, message: "Multipart part must occur at most once." };
  }
  return undefined;
}

function decodeMultipartTuple(
  descriptors: readonly MultipartPartDescriptor[],
  body: ParsedMultipartBody,
): DecoderResult<unknown[]> {
  const assignment = resolveTupleCardinality(descriptors, body);
  if (isLeft(assignment)) return assignment;

  const output: unknown[] = [];
  const issues: ValidationIssue[] = [];
  let partIndex = 0;
  for (let descriptorIndex = 0; descriptorIndex < descriptors.length; descriptorIndex++) {
    const descriptor = descriptors[descriptorIndex]!;
    const count = assignment.right[descriptorIndex]!;
    if (count === 0 && descriptor.optional) {
      output.push(undefined);
    } else if (descriptor.multi) {
      const values = body.parts.slice(partIndex, partIndex + count);
      const decoded = traverseEither(values, (part, repeatedIndex) =>
        prefixIssues(
          decodeMultipartTuplePart(descriptor, part, body.mediaType),
          `[${descriptorIndex}][${repeatedIndex}]`,
        ),
      );
      if (isLeft(decoded)) issues.push(...decoded.left);
      else output.push(decoded.right);
    } else {
      const decoded = prefixIssues(
        decodeMultipartTuplePart(descriptor, body.parts[partIndex]!, body.mediaType),
        `[${descriptorIndex}]`,
      );
      if (isLeft(decoded)) issues.push(...decoded.left);
      else output.push(decoded.right);
    }
    partIndex += count;
  }

  return issues.length > 0 ? failMany(issues) : succeed(output);
}

function decodeMultipartTuplePart(
  descriptor: MultipartPartDescriptor,
  part: ParsedMultipartPart,
  outerMediaType: string,
): DecoderResult<unknown> {
  const expectedName = descriptor.name;
  const actualDisposition = part.disposition;
  if (outerMediaType === "multipart/form-data") {
    if (!expectedName) {
      return fail("", "Tuple form-data parts require a declared wire name.");
    }
    if (actualDisposition?.type !== "form-data" || actualDisposition.name !== expectedName) {
      return fail("", `Expected multipart form-data part named "${expectedName}".`);
    }
  } else if (expectedName !== undefined && actualDisposition?.name !== expectedName) {
    return fail("", `Expected multipart part named "${expectedName}".`);
  }
  return decodeMultipartPart(descriptor, part);
}

function resolveTupleCardinality(
  descriptors: readonly MultipartPartDescriptor[],
  body: ParsedMultipartBody,
): DecoderResult<number[]> {
  const received = body.parts.length;
  const minimum = descriptors.reduce(
    (total, descriptor) => total + (descriptor.optional ? 0 : 1),
    0,
  );
  const hasMulti = descriptors.some((descriptor) => descriptor.multi);
  const maximum = hasMulti ? Number.POSITIVE_INFINITY : descriptors.length;
  if (received < minimum) {
    return fail("", `Expected at least ${minimum} multipart part(s), received ${received}.`);
  }
  if (received > maximum) {
    return fail("", `Expected at most ${maximum} multipart part(s), received ${received}.`);
  }

  interface Match {
    readonly ways: 0 | 1 | 2;
    readonly counts?: readonly number[];
  }
  const solve = (useWireEvidence: boolean): Match => {
    const memo = new Map<string, Match>();
    const match = (descriptorIndex: number, partIndex: number): Match => {
      const memoKey = `${descriptorIndex}:${partIndex}`;
      const cached = memo.get(memoKey);
      if (cached) return cached;
      if (descriptorIndex === descriptors.length) {
        const terminal: Match =
          partIndex === body.parts.length ? { ways: 1, counts: [] } : { ways: 0 };
        memo.set(memoKey, terminal);
        return terminal;
      }

      const descriptor = descriptors[descriptorIndex]!;
      const min = descriptor.optional ? 0 : 1;
      const available = body.parts.length - partIndex;
      const max = descriptor.multi ? available : Math.min(1, available);
      let ways: 0 | 1 | 2 = 0;
      let firstCounts: readonly number[] | undefined;
      for (let count = min; count <= max; count++) {
        if (
          useWireEvidence &&
          count > 0 &&
          !tuplePartMatchesDescriptor(
            descriptor,
            body.parts[partIndex + count - 1]!,
            body.mediaType,
          )
        ) {
          break;
        }
        const suffix = match(descriptorIndex + 1, partIndex + count);
        if (suffix.ways === 0) continue;
        if (!firstCounts && suffix.counts) firstCounts = [count, ...suffix.counts];
        ways = Math.min(2, ways + suffix.ways) as 1 | 2;
        if (ways === 2) break;
      }
      const result: Match = firstCounts ? { ways, counts: firstCounts } : { ways: 0 };
      memo.set(memoKey, result);
      return result;
    };
    return match(0, 0);
  };
  let solution = solve(true);

  if (solution.ways === 0 || !solution.counts) {
    // When cardinality itself has exactly one interpretation, preserve that
    // assignment so the regular part decoder can report the precise invalid
    // name, media type, or filename issue.
    const cardinalityOnly = solve(false);
    if (cardinalityOnly.ways === 1 && cardinalityOnly.counts) {
      solution = cardinalityOnly;
    } else {
      return fail("", "Multipart tuple parts do not match their declared wire contracts.");
    }
  }
  if (solution.ways > 1) {
    return fail(
      "",
      "Multipart tuple cardinality is ambiguous after matching part names and media types.",
    );
  }
  const resolvedCounts = solution.counts;
  return resolvedCounts
    ? succeed([...resolvedCounts])
    : fail("", "Multipart tuple cardinality could not be resolved.");
}

function tuplePartMatchesDescriptor(
  descriptor: MultipartPartDescriptor,
  part: ParsedMultipartPart,
  outerMediaType: string,
): boolean {
  if (outerMediaType === "multipart/form-data") {
    if (
      !descriptor.name ||
      part.disposition?.type !== "form-data" ||
      part.disposition.name !== descriptor.name
    ) {
      return false;
    }
  } else if (descriptor.name !== undefined && part.disposition?.name !== descriptor.name) {
    return false;
  }
  if (descriptor.requireContentType && !part.contentType) return false;
  if (
    part.contentType &&
    descriptor.contentTypes &&
    descriptor.contentTypes.length > 0 &&
    !isContentTypeAccepted(part.contentType, descriptor.contentTypes)
  ) {
    return false;
  }
  const kind = selectMultipartPartKind(descriptorDecoders(descriptor), part.contentType);
  if (isLeft(kind)) return false;
  if (kind.right === "file" && descriptor.requireFileName) {
    const filename =
      descriptor.fileNameHeader === undefined
        ? part.disposition?.filename
        : part.headers.get(descriptor.fileNameHeader.toLowerCase());
    if (filename === undefined) return false;
    try {
      validateFileName(filename);
    } catch {
      return false;
    }
  }
  return true;
}

function decodeMultipartPart(
  descriptor: MultipartPartDescriptor,
  part: ParsedMultipartPart,
): DecoderResult<unknown> {
  const declared = descriptor.contentTypes ?? [];
  if (descriptor.requireContentType && !part.contentType) {
    return fail("", "Expected a multipart part Content-Type.");
  }
  if (
    part.contentType &&
    declared.length > 0 &&
    !isContentTypeAccepted(part.contentType, declared)
  ) {
    return fail(
      "",
      `Multipart part content type "${part.contentType}" is outside its declared contract.`,
    );
  }

  const decoders = descriptorDecoders(descriptor);
  const kind = selectMultipartPartKind(decoders, part.contentType);
  if (isLeft(kind)) return kind;
  const decoder = decoders[kind.right];
  if (!decoder) {
    return fail(
      "",
      `Multipart part content type ${JSON.stringify(part.contentType ?? null)} has no decoder.`,
    );
  }

  let wireValue: unknown;
  try {
    switch (kind.right) {
      case "text":
        wireValue = strictMultipartText(part.body);
        break;
      case "binary":
        wireValue = part.body;
        break;
      case "json":
        wireValue = parseJsonText(strictMultipartText(part.body));
        break;
      case "file":
        wireValue = multipartFile(descriptor, part);
        break;
    }
  } catch (error) {
    if (error instanceof MultipartSyntaxError) return fail("", error.message);
    return fail(
      "",
      kind.right === "json"
        ? "Multipart part must contain valid JSON."
        : "Multipart text part must contain valid UTF-8.",
    );
  }
  return decoder.decode(wireValue);
}

function descriptorDecoders(descriptor: MultipartPartDescriptor): MultipartPartDecoderMap {
  return descriptor.decoders ?? { [descriptor.kind]: descriptor.decoder };
}

function selectMultipartPartKind(
  decoders: MultipartPartDecoderMap,
  contentType: string | undefined,
): DecoderResult<MultipartPartKind> {
  const kinds = availableMultipartPartKinds(decoders);
  if (kinds.length === 1) return succeed(kinds[0]!);

  const mediaKind = multipartMediaKind(contentType);
  if (mediaKind && decoders[mediaKind]) return succeed(mediaKind);
  if (!contentType && decoders.text) return succeed("text");
  if (!contentType) {
    return fail("", "Multipart part omits Content-Type, so its representation is ambiguous.");
  }
  return fail("", `Multipart part content type "${contentType}" has no matching decoder.`);
}

function availableMultipartPartKinds(decoders: MultipartPartDecoderMap): MultipartPartKind[] {
  return MULTIPART_PART_KINDS.filter((kind) => decoders[kind] !== undefined);
}

function multipartMediaKind(contentType: string | undefined): MultipartPartKind | undefined {
  if (!contentType) return undefined;
  if (contentType === "application/json" || contentType.endsWith("+json")) return "json";
  if (contentType.startsWith("text/")) return "text";
  return "binary";
}

function multipartFile(descriptor: MultipartPartDescriptor, part: ParsedMultipartPart): File {
  const relocated = descriptor.fileNameHeader;
  const filename =
    relocated === undefined
      ? part.disposition?.filename
      : part.headers.get(relocated.toLowerCase());
  if (filename === undefined && descriptor.requireFileName) {
    throw new MultipartSyntaxError(
      relocated === undefined
        ? "Multipart File is missing its filename parameter."
        : `Multipart File is missing its "${relocated.toLowerCase()}" filename header.`,
    );
  }
  const normalizedName = filename ?? "";
  validateFileName(normalizedName);
  return createFile(part.body, normalizedName, part.contentType ?? "");
}

function strictMultipartText(bytes: Uint8Array): string {
  return strictUtf8Decoder.decode(bytes);
}

function isHeaderName(name: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);
}

export const multipartDecoders = {
  multipartFormData: multipartFormDataDecoder,
  multipartTuple: multipartTupleDecoder,
} as const;

export async function parseMultipartBody(request: Request): Promise<Record<string, unknown>> {
  const parsed = await parseMultipartRequest(request);
  const legacy = collectLegacyMultipartFields(parsed);
  Object.defineProperty(legacy, MULTIPART_BODY, {
    configurable: false,
    enumerable: false,
    value: parsed,
    writable: false,
  });
  return legacy as MultipartDecoderInput;
}

function collectLegacyMultipartFields(body: ParsedMultipartBody): Record<string, unknown> {
  const value: Record<string, unknown> = Object.create(null);
  for (const part of body.parts) {
    const disposition = part.disposition;
    if (disposition?.type !== "form-data" || !disposition.name) continue;

    const partValue =
      disposition.filename !== undefined
        ? createFile(part.body, disposition.filename, part.contentType ?? "")
        : new TextDecoder().decode(part.body);
    appendBodyField(value, disposition.name, partValue);
  }
  return value;
}
