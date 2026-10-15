import {
  isPlainRecord,
  mergeLandofiles,
  mergeValues,
  override,
  reset,
  resolveLayerMergeRule,
} from "@lando/sdk/landofile";
import { type ConfigTranslateSourceId, type LandofileLayer, LandofileShape } from "@lando/sdk/schema";
import { equal, record, sorted } from "./layer-delta-values.ts";

export interface DesiredPrefix {
  readonly layer: LandofileLayer;
  readonly sourceIds: ReadonlyArray<ConfigTranslateSourceId>;
  readonly desired: Readonly<Record<string, unknown>>;
}

const unchanged = Symbol("unchanged");
const delta = (left: unknown, right: unknown, path: ReadonlyArray<string | number>): unknown => {
  if (equal(left, right, path)) return unchanged;
  const rule = resolveLayerMergeRule(LandofileShape, path);
  const base = rule.entries(left);
  const higher = rule.entries(right);
  if (rule.descriptor.kind === "keyed" && base !== undefined && higher !== undefined) {
    if (higher.length === 0) return right;
    if ([...base, ...higher].some((item) => rule.key(item) === undefined)) return right;
    const collides = (items: ReadonlyArray<unknown>) =>
      items.some((item, index) => items.slice(index + 1).some((other) => rule.key(item) === rule.key(other)));
    if (collides(base) || collides(higher)) return override(right);
    const changed = higher.map((item) => {
      const previous = base.find((candidate) => rule.key(candidate) === rule.key(item));
      return previous === undefined || !equal(previous, item);
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
        : higher.filter((_, index) => changed[index]);
    return equal(mergeValues(LandofileShape, left, changes, path), right, path)
      ? changes.length === 0
        ? unchanged
        : changes
      : override(right);
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return right;
  const fragment: Record<string, unknown> = {};
  for (const key of Object.keys(left).sort()) if (!Object.hasOwn(right, key)) fragment[key] = reset();
  for (const key of Object.keys(right).sort()) {
    const value = Object.hasOwn(left, key) ? delta(left[key], right[key], [...path, key]) : right[key];
    if (value !== unchanged) fragment[key] = value;
  }
  return Object.keys(fragment).length === 0 ? unchanged : fragment;
};

export const planLayerDeltas = (
  prefixes: ReadonlyArray<DesiredPrefix>,
): {
  readonly emitted: ReadonlyArray<{
    readonly layer: LandofileLayer;
    readonly fragment: Readonly<Record<string, unknown>>;
  }>;
} => {
  const emitted: { layer: LandofileLayer; fragment: Record<string, unknown> }[] = [];
  let accumulated: Record<string, unknown> = {};
  for (const prefix of prefixes) {
    const fragment = delta(accumulated, prefix.desired, []);
    const candidate = fragment === unchanged ? {} : record(sorted(fragment));
    accumulated = mergeLandofiles([accumulated, candidate]);
    if (!equal(accumulated, prefix.desired)) throw new Error(`Layer delta replay failed at ${prefix.layer}`);
    emitted.push({ layer: prefix.layer, fragment: candidate });
  }
  return { emitted };
};
