import {
  isLandofileOverride,
  isLandofileReset,
  isMergeDirective,
  isPlainRecord,
  override,
  resolveLayerMergeRule,
} from "@lando/sdk/landofile";
import { LandofileShape } from "@lando/sdk/schema";

export const equal = (left: unknown, right: unknown, path: ReadonlyArray<string | number> = []): boolean => {
  if (Object.is(left, right)) return true;
  if (isMergeDirective(left) || isMergeDirective(right))
    return (
      (isLandofileReset(left) && isLandofileReset(right)) ||
      (isLandofileOverride(left) && isLandofileOverride(right) && equal(left.value, right.value, path))
    );
  if (Array.isArray(left) && Array.isArray(right)) {
    const rule = resolveLayerMergeRule(LandofileShape, path);
    const routes = rule.descriptor.kind === "keyed" && rule.descriptor.identity === "route-match";
    const a = routes ? (rule.entries(left) ?? left) : left;
    const b = routes ? (rule.entries(right) ?? right) : right;
    return a.length === b.length && a.every((value, index) => equal(value, b[index], [...path, index]));
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.keys(left).every(
      (key) => Object.hasOwn(right, key) && equal(left[key], right[key], [...path, key]),
    )
  );
};

export const sorted = (value: unknown): unknown => {
  if (isLandofileReset(value)) return value;
  if (isLandofileOverride(value)) return override(sorted(value.value));
  if (Array.isArray(value)) return value.map(sorted);
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted(value[key])]),
  );
};

export const record = (value: unknown): Record<string, unknown> => {
  if (!isPlainRecord(value)) throw new Error("Layer delta must be a record");
  return value;
};
