import { isPlainRecord, mergeLandofiles, mergeValues, resolveLayerMergeRule } from "@lando/sdk/landofile";
import { type ConfigTranslateSourceId, type LandofileLayer, LandofileShape } from "@lando/sdk/schema";

import {
  type Path,
  type Relocation,
  atPath,
  containingUnit,
  dropRemovedServiceDependencies,
  equal,
  omit,
  record,
  schemaPath,
  sorted,
} from "./layer-delta-values.ts";
export interface DesiredPrefix {
  readonly layer: LandofileLayer;
  readonly sourceIds: ReadonlyArray<ConfigTranslateSourceId>;
  /** Complete config that must be in force after this layer merges. */
  readonly desired: Readonly<Record<string, unknown>>;
}
interface LayerDeltaResult {
  readonly emitted: ReadonlyArray<{
    readonly layer: LandofileLayer;
    readonly fragment: Readonly<Record<string, unknown>>;
  }>;
  readonly relocations: ReadonlyArray<Relocation>;
}
const unchanged = Symbol("unchanged");
interface DeltaContext {
  readonly path: Path;
  readonly removals: Path[];
}
const delta = (left: unknown, right: unknown, context: DeltaContext): unknown => {
  if (equal(left, right, schemaPath(context.path))) return unchanged;
  const { path, removals } = context;
  const collectionPath = schemaPath(path);
  const rule = resolveLayerMergeRule(LandofileShape, collectionPath);
  const baseEntries = rule.entries(left);
  const overlayEntries = rule.entries(right);
  if (Array.isArray(left) && Array.isArray(right) && rule.descriptor.kind === "replace") return right;
  if (rule.descriptor.kind === "keyed" && baseEntries !== undefined && overlayEntries !== undefined) {
    if (overlayEntries.length === 0) return right;
    const key = path.at(-1)?.key;
    if ([...baseEntries, ...overlayEntries].some((item) => rule.key(item) === undefined)) return right;
    const matches = (candidate: unknown, item: unknown) => rule.key(candidate) === rule.key(item);
    const itemPath = (item: unknown): Path => {
      const identity = rule.key(item);
      if (key === undefined || identity === undefined) return containingUnit(path);
      return [...path.slice(0, -1), { kind: "item", key, identity }];
    };
    const collides = (items: readonly unknown[]) =>
      items.some((item, index) =>
        items.slice(index + 1).some((other) => matches(item, other) || matches(other, item)),
      );
    const arrayRemovals: Path[] = [];
    const ambiguous = collides(baseEntries) || collides(overlayEntries);
    const changed = overlayEntries.map((item) => {
      const previous = baseEntries.find((candidate) => matches(candidate, item));
      if (previous === undefined) return true;
      const projectedBase = rule.matched(previous);
      const projectedOverlay = rule.matched(item);
      if (equal(mergeValues(LandofileShape, [previous], [item], collectionPath), [item]))
        return !equal(previous, item);
      return (
        delta(projectedBase, projectedOverlay, { path: itemPath(item), removals: arrayRemovals }) !==
        unchanged
      );
    });
    let offset = 0;
    const changes =
      rule.preserveDuplicates && Array.isArray(right)
        ? right.flatMap((original) => {
            const parts = rule.parts(original);
            const changedParts = parts.filter((_, index) => changed[offset + index]);
            offset += parts.length;
            return changedParts.length === parts.length ? [original] : changedParts;
          })
        : overlayEntries.filter((_, index) => changed[index]);
    // Replay owns representability; hoisting any child must preserve the entire
    // outer array because keyed merge updates in place and only appends new items.
    if (
      ambiguous ||
      arrayRemovals.length > 0 ||
      !equal(mergeValues(LandofileShape, left, changes, collectionPath), right, collectionPath)
    )
      removals.push(containingUnit(path));
    return changes.length === 0 ? unchanged : changes;
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return right;
  for (const key of Object.keys(left).sort())
    if (!Object.hasOwn(right, key)) {
      const ownPath: Path = [...path, { kind: "key", key }];
      removals.push(containingUnit(isPlainRecord(left[key]) || path.length === 0 ? ownPath : path));
    }
  const fragment: Record<string, unknown> = {};
  for (const key of Object.keys(right).sort()) {
    const value = Object.hasOwn(left, key)
      ? delta(left[key], right[key], { path: [...path, { kind: "key", key }], removals })
      : right[key];
    if (value !== unchanged) fragment[key] = value;
  }
  if (
    !equal(mergeValues(LandofileShape, left, fragment, collectionPath), right, collectionPath) &&
    removals.length === 0
  ) {
    if (path.length > 0) removals.push(containingUnit(path));
    else {
      const replayed = record(mergeValues(LandofileShape, left, fragment, collectionPath));
      const key = [...new Set([...Object.keys(left), ...Object.keys(right)])]
        .sort()
        .find(
          (key) =>
            Object.hasOwn(replayed, key) !== Object.hasOwn(right, key) || !equal(replayed[key], right[key]),
        );
      if (key !== undefined) removals.push([{ kind: "key", key }]);
    }
  }
  return Object.keys(fragment).length === 0 ? unchanged : fragment;
};

export const planLayerDeltas = (prefixes: ReadonlyArray<DesiredPrefix>): LayerDeltaResult => {
  const relocations: Relocation[] = [];
  const masks: { readonly path: Path; readonly before: number }[] = [];
  const distinctUnits = new Set<string>();
  let previous: Record<string, unknown>[] = [];
  let iterations = 0;
  // Failed item replays coarsen to the outer array, then a containing map key:
  // escalation only reaches strict ancestors. A unit's omission frontier only
  // moves to higher layers; masks never shrink. Finite paths and layers permit
  // at most N * U restarts, plus two passes to confirm the fixed point.
  for (;;) {
    const fragments: Record<string, unknown>[] = [];
    let restart = false;
    for (const [index, prefix] of prefixes.entries()) {
      const desired = masks.reduce<unknown>(
        (value, mask) => (index < mask.before ? omit(value, mask.path) : value),
        prefix.desired,
      );
      const removals: Path[] = [];
      const accumulated = mergeLandofiles(fragments);
      const fragment = delta(accumulated, desired, { path: [], removals });
      const unit = removals[0];
      if (unit !== undefined) {
        const name = JSON.stringify(unit);
        distinctUnits.add(name);
        if (
          masks.some((mask) => mask.before >= index && equal(mask.path, unit)) ||
          ++iterations > prefixes.length * distinctUnits.size
        )
          throw new Error(`Layer delta fixpoint exceeded for unit ${name}`);
        const deleted = fragments.map((value) => record(omit(value, unit)));
        const omittedFrom = prefixes
          .slice(0, index)
          .filter((_, j) => !equal(fragments[j], deleted[j]))
          .map(({ layer }) => layer);
        const changedPrefixes = prefixes
          .slice(0, index)
          .filter(
            (_, j) =>
              !equal(
                atPath(mergeLandofiles(fragments.slice(0, j + 1)), unit),
                atPath(mergeLandofiles(deleted.slice(0, j + 1)), unit),
              ),
          )
          .map(({ layer }) => layer);
        const sourceIds = [
          ...new Set(
            prefixes
              .slice(0, index + 1)
              .filter((entry, j) => j === index || omittedFrom.includes(entry.layer))
              .flatMap(({ sourceIds }) => sourceIds),
          ),
        ];
        relocations.push({
          unitPath: unit,
          hoistedTo: prefix.layer,
          omittedFrom,
          changedPrefixes,
          sourceIds,
        });
        masks.push({ path: unit, before: index });
        restart = true;
        break;
      }
      const partial = fragment === unchanged ? {} : record(sorted(fragment));
      // A recipe object is decoded on its own layer before merge, so a delta
      // that only carries a changed option is not a Landofile. Emit the
      // prefix's full recipe; deep-merge still keeps the highest options.
      const recipe = isPlainRecord(desired) ? desired.recipe : undefined;
      const candidate =
        isPlainRecord(partial.recipe) && isPlainRecord(recipe)
          ? record(sorted({ ...partial, recipe }))
          : partial;
      if (!equal(mergeValues(LandofileShape, accumulated, candidate), desired))
        throw new Error(`Layer delta replay failed at ${prefix.layer}`);
      fragments.push(candidate);
    }
    if (restart) continue;
    if (!equal(previous, fragments)) {
      previous = fragments;
      continue;
    }
    const cleaned = dropRemovedServiceDependencies(fragments, relocations, prefixes.at(-1)?.desired ?? {});
    if (!equal(mergeLandofiles(cleaned), prefixes.at(-1)?.desired ?? {}))
      throw new Error("Layer delta final desired postcondition failed");
    return {
      emitted: prefixes.map(({ layer }, index) => ({ layer, fragment: cleaned[index] ?? {} })),
      relocations,
    };
  }
};
