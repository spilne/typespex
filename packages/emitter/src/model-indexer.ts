import type { Model, Type } from "@typespec/compiler";
import { isNeverType, isType, walkPropertiesInherited } from "@typespec/compiler";
import { getNamespaceFullName } from "./namespace-names.js";

export interface EffectiveStringIndexer {
  /** The model that contributes the effective indexer. */
  readonly source: Model;
  readonly value: Type;
}

/**
 * Return the string indexer that applies to a model.
 *
 * TypeSpec stores indexers introduced by `is` and spreads on the resulting
 * model, but an indexer inherited with `extends` remains on the base model.
 * Some compiler-created `TypeSpec.Record<T>` instances also expose only their
 * template argument, so retain a nominal fallback for those instances.
 */
export function getEffectiveStringIndexer(model: Model): EffectiveStringIndexer | undefined {
  return getEffectiveStringIndexers(model)[0];
}

export function getEffectiveStringIndexers(model: Model): readonly EffectiveStringIndexer[] {
  return findEffectiveStringIndexers(model, new Set());
}

export function getAdditionalPropertiesValue(model: Model): Type | undefined {
  return getEffectiveStringIndexer(model)?.value;
}

export function getAdditionalPropertiesValues(model: Model): readonly Type[] {
  return getEffectiveStringIndexers(model).map((indexer) => indexer.value);
}

/**
 * A pure record has an effective string indexer and no declared or inherited
 * properties. Models that combine fields with an indexer must retain both.
 */
export function isPureRecordModel(model: Model): boolean {
  if (!getEffectiveStringIndexer(model)) return false;
  return walkPropertiesInherited(model).next().done === true;
}

/** `Record<never>` explicitly disallows additional properties. */
export function isNeverAdditionalProperties(model: Model): boolean {
  const values = getAdditionalPropertiesValues(model);
  return values.length > 0 && values.every(isNeverType);
}

function getNominalRecordValue(model: Model): Type | undefined {
  if (getNamespaceFullName(model.namespace) !== "TypeSpec" || model.name !== "Record") {
    return undefined;
  }

  const args = model.templateMapper?.args ?? [];
  return args.length === 1 && isType(args[0]) ? args[0] : undefined;
}

function findEffectiveStringIndexers(model: Model, seen: Set<Model>): EffectiveStringIndexer[] {
  if (seen.has(model)) return [];
  seen.add(model);

  const indexer = model.indexer;
  if (indexer?.key.name === "string") {
    return [{ source: model, value: indexer.value }];
  }

  const recordValue = getNominalRecordValue(model);
  if (recordValue) {
    return [{ source: model, value: recordValue }];
  }

  // Generic declarations do not always receive a semantic `model.indexer`.
  // Their `is`/spread sources still retain the instantiated Record<T>, so walk
  // those sources. Finished synthetic/projection models can deliberately drop
  // a source indexer, so never resurrect one there.
  const candidates: EffectiveStringIndexer[] = [];
  if (!model.isFinished) {
    const isSource = model.sourceModels.find((source) => source.usage === "is");
    if (isSource) {
      return findEffectiveStringIndexers(isSource.model, seen);
    }

    for (const usage of ["spread", "intersection"] as const) {
      for (const source of model.sourceModels) {
        if (source.usage !== usage) continue;
        candidates.push(...findEffectiveStringIndexers(source.model, seen));
      }
      if (candidates.length > 0) return uniqueIndexers(candidates);
    }
  }

  if (model.baseModel) {
    return findEffectiveStringIndexers(model.baseModel, seen);
  }

  return [];
}

function uniqueIndexers(candidates: readonly EffectiveStringIndexer[]): EffectiveStringIndexer[] {
  const values = new Set<Type>();
  return candidates.filter((candidate) => {
    if (values.has(candidate.value)) return false;
    values.add(candidate.value);
    return true;
  });
}
