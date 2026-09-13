import type { Model, Program, Type, Union } from "@typespec/compiler";
import { createMetadataInfo, type MetadataInfo } from "@typespec/http";
import type { PayloadProjection } from "./payload-context.js";
import type { ScalarEncodingContext } from "./scalar-encoding.js";

export interface PayloadTypeAliasEntry {
  readonly name: string;
  readonly type: Model | Union;
  readonly projection: PayloadProjection;
  declaration?: string;
}

export interface PayloadPlanningState {
  readonly metadata: MetadataInfo;
  readonly aliases: Map<Type, Map<string, PayloadTypeAliasEntry>>;
  readonly projectionChanges: Map<Type, Map<string, boolean>>;
  readonly projectionFilters: Map<Type, Map<string, boolean>>;
  readonly usedAliasNames: Set<string>;
}

export interface JsonSerializerEntry {
  readonly name: string;
  readonly type: Model | Union;
  readonly projection?: PayloadProjection;
  readonly encodingContext: ScalarEncodingContext;
  declaration?: string;
  building?: boolean;
}

export interface JsonPlanningState {
  readonly changes: Map<Type, Map<string, boolean>>;
  readonly serializers: Map<Model | Union, Map<string, JsonSerializerEntry>>;
  readonly usedNames: Set<string>;
}

export interface XmlCodecEntry {
  readonly name: string;
  readonly type: Model | Union;
  readonly projection?: PayloadProjection;
  declaration?: string;
  building?: boolean;
}

export interface XmlPlanningState {
  readonly codecs: Map<Model | Union, Map<string, XmlCodecEntry>>;
  readonly usedNames: Set<string>;
}

/** Mutable compiler-backed state owned by one service planning context. */
export interface HttpPlanningState {
  readonly payload: PayloadPlanningState;
  readonly json: JsonPlanningState;
  readonly xml: XmlPlanningState;
  referencedTypeNames: Set<string> | undefined;
}

export function createHttpPlanningState(
  program: Program,
  typeNames: ReadonlyMap<string, string>,
): HttpPlanningState {
  return {
    payload: {
      metadata: createMetadataInfo(program),
      aliases: new Map(),
      projectionChanges: new Map(),
      projectionFilters: new Map(),
      usedAliasNames: new Set(typeNames.values()),
    },
    json: {
      changes: new Map(),
      serializers: new Map(),
      usedNames: new Set(typeNames.values()),
    },
    xml: {
      codecs: new Map(),
      usedNames: new Set(),
    },
    referencedTypeNames: undefined,
  };
}
