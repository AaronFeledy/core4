/**
 * Landofile merge semantics.
 *
 * Default load order (low → high precedence):
 *   1. .lando.base.yml
 *   2. .lando.dist.yml
 *   3. .lando.upstream.yml
 *   4. .lando.yml          (canonical)
 *   5. .lando.local.yml
 *   6. .lando.user.yml
 *
 * Rules:
 * - Files load in order; later files override earlier files.
 * - Maps deep-merge.
 * - Arrays of scalars replace.
 * - Arrays of objects merge by recognized identity keys: `name`, `id`,
 *   `hostname`, `service`, schema-specific keys.
 * - Route `filters` arrays merge by `name` when present, otherwise by `type`.
 *   Named filters never match unnamed filters.
 * - Custom file basenames and pre/post lists live in *global config*, not
 *   in Landofiles.
 * - The final `name:` is taken from the highest-precedence file that
 *   defines it.
 *
 */

import { routeFilterIdentity, routeFilterMatches } from "./route-filters.ts";

export const DEFAULT_PRE_LANDOFILES = [".lando.base.yml", ".lando.dist.yml", ".lando.upstream.yml"] as const;

export const DEFAULT_LANDOFILE = ".lando.yml" as const;

export const DEFAULT_POST_LANDOFILES = [".lando.local.yml", ".lando.user.yml"] as const;

/**
 * Identity keys for array-of-objects merge.
 */
export const ARRAY_IDENTITY_KEYS = ["name", "id", "hostname", "service"] as const;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const identityKeyFor = (item: Record<string, unknown>): (typeof ARRAY_IDENTITY_KEYS)[number] | undefined =>
  ARRAY_IDENTITY_KEYS.find((key) => Object.hasOwn(item, key));

const mergeArrays = (
  left: ReadonlyArray<unknown>,
  right: ReadonlyArray<unknown>,
  arrayKey?: string,
): ReadonlyArray<unknown> => {
  if (!left.every(isPlainRecord) || !right.every(isPlainRecord)) return right;

  if (arrayKey === "filters") {
    if ([...left, ...right].some((item) => routeFilterIdentity(item) === undefined)) return right;

    const merged: Record<string, unknown>[] = left.map((item) => ({ ...item }));
    for (const item of right) {
      const existingIndex = merged.findIndex((candidate) => routeFilterMatches(candidate, item));
      if (existingIndex === -1) {
        merged.push({ ...item });
        continue;
      }
      const existing = merged[existingIndex];
      if (existing !== undefined) {
        const existingType = existing.type;
        const overlayType = item.type;
        merged[existingIndex] =
          typeof existingType === "string" && typeof overlayType === "string" && existingType !== overlayType
            ? { ...item }
            : (mergeValues(existing, item) as Record<string, unknown>);
      }
    }
    return merged;
  }

  const keyed = [...left, ...right].map((item) => ({ item, key: identityKeyFor(item) }));
  if (keyed.some(({ key }) => key === undefined)) return right;

  const merged: Record<string, unknown>[] = left.map((item) => ({ ...item }));
  for (const item of right) {
    const key = identityKeyFor(item);
    if (key === undefined) return right;
    const identity = item[key];
    const existingIndex = merged.findIndex((candidate) => candidate[key] === identity);
    if (existingIndex === -1) {
      merged.push({ ...item });
      continue;
    }
    const existing = merged[existingIndex];
    if (existing !== undefined)
      merged[existingIndex] = mergeValues(existing, item) as Record<string, unknown>;
  }
  return merged;
};

/**
 * Landofile overlay merge: deep-merge maps, replace scalar arrays, merge
 * object arrays by recognized identity key (route `filters` by name, then
 * unnamed type), right-wins for scalars. Also used when service-type
 * `extends:` overlays parent config onto the child.
 */
export const mergeValues = (left: unknown, right: unknown, key?: string): unknown => {
  if (Array.isArray(left) && Array.isArray(right)) return mergeArrays(left, right, key);
  if (!isPlainRecord(left) || !isPlainRecord(right)) return right;

  const result: Record<string, unknown> = { ...left };
  for (const [childKey, rightValue] of Object.entries(right)) {
    result[childKey] = Object.hasOwn(result, childKey)
      ? mergeValues(result[childKey], rightValue, childKey)
      : rightValue;
  }
  return result;
};

export const mergeLandofiles = <T extends Record<string, unknown>>(files: ReadonlyArray<T>): T =>
  files.reduce<Record<string, unknown>>(
    (merged, file) => mergeValues(merged, file) as Record<string, unknown>,
    {},
  ) as T;
