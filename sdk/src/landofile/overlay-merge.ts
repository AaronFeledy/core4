import type { Schema } from "effect";
import { LandofileShape } from "../schema/landofile.ts";
import { resolveLayerMergeRule } from "./layer-merge-rules.ts";
import { isPlainRecord } from "./record.ts";

export { isPlainRecord } from "./record.ts";
export { routeFilterIdentity, routeFilterMatches, type RouteFilterIdentity } from "./layer-merge-rules.ts";

/** Merge partial authored values using the declared collection rules of the supplied root. */
export const mergeValues = (
  root: Schema.Top,
  left: unknown,
  right: unknown,
  path: ReadonlyArray<string | number> = [],
): unknown => {
  const rule = resolveLayerMergeRule(root, path);
  if (Array.isArray(right) && right.length === 0) return right;
  if (rule.descriptor.kind === "keyed") {
    const base = rule.entries(left);
    const overlay = rule.entries(right);
    if (base !== undefined && overlay !== undefined) {
      const baseKeys = base.map(rule.key);
      const overlayKeys = overlay.map(rule.key);
      if (baseKeys.includes(undefined) || overlayKeys.includes(undefined)) return right;
      const mergeEntry = (item: unknown, higher: unknown, index: number): unknown => {
        if (
          rule.descriptor.kind === "keyed" &&
          rule.descriptor.onMatch === "replace-on-type-change" &&
          isPlainRecord(item) &&
          isPlainRecord(higher) &&
          typeof item.type === "string" &&
          typeof higher.type === "string" &&
          item.type !== higher.type
        )
          return higher;
        return mergeValues(root, rule.matched(item), rule.matched(higher), [...path, index]);
      };
      if (!rule.preserveDuplicates) {
        const merged = [...base];
        for (const higher of overlay) {
          const index = merged.findIndex((item) => rule.key(item) === rule.key(higher));
          if (index < 0) merged.push(higher);
          else merged[index] = mergeEntry(merged[index], higher, index);
        }
        return merged;
      }
      if (Array.isArray(left) && Array.isArray(right)) {
        const consumed = new Set<number>();
        const merged = left.flatMap((original, index) => {
          let matched = false;
          const parts = rule.parts(original).map((item) => {
            const match = overlayKeys.findIndex((key, i) => key === rule.key(item) && !consumed.has(i));
            if (match < 0) return item;
            matched = true;
            consumed.add(match);
            return mergeEntry(item, overlay[match], index);
          });
          return matched ? parts : [original];
        });
        let offset = 0;
        const appended = right.flatMap((original) => {
          const parts = rule.parts(original);
          const unmatched = parts.filter((_, index) => !consumed.has(offset + index));
          offset += parts.length;
          return unmatched.length === parts.length ? [original] : unmatched;
        });
        return [...merged, ...appended];
      }
    }
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return right;
  const result: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    result[key] = Object.hasOwn(left, key) ? mergeValues(root, left[key], value, [...path, key]) : value;
  }
  return result;
};

/** Fold Landofile fragments from lowest to highest precedence; validation belongs to the caller. */
export const mergeLandofiles = (layers: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> =>
  layers.reduce<Record<string, unknown>>((left, right) => {
    const merged = mergeValues(LandofileShape, left, right);
    return isPlainRecord(merged) ? merged : right;
  }, {});
