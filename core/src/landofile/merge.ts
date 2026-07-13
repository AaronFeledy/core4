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
 * - Custom file basenames and pre/post lists live in *global config*, not
 *   in Landofiles.
 * - The final `name:` is taken from the highest-precedence file that
 *   defines it.
 *
 */

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

const mergeArrays = (left: ReadonlyArray<unknown>, right: ReadonlyArray<unknown>): ReadonlyArray<unknown> => {
  if (!left.every(isPlainRecord) || !right.every(isPlainRecord)) return right;

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
 * The §7.2 overlay primitive: deep-merge maps, replace scalar arrays, merge
 * object arrays by recognized identity key, right-wins for scalars. Reused for
 * service-type `extends:` resolution overlay (§6.11.1), which the spec defines
 * in terms of these same merge rules.
 */
export const mergeValues = (left: unknown, right: unknown): unknown => {
  if (Array.isArray(left) && Array.isArray(right)) return mergeArrays(left, right);
  if (!isPlainRecord(left) || !isPlainRecord(right)) return right;

  const result: Record<string, unknown> = { ...left };
  for (const [key, rightValue] of Object.entries(right)) {
    result[key] = Object.hasOwn(result, key) ? mergeValues(result[key], rightValue) : rightValue;
  }
  return result;
};

export const mergeLandofiles = <T extends Record<string, unknown>>(files: ReadonlyArray<T>): T =>
  files.reduce<Record<string, unknown>>(
    (merged, file) => mergeValues(merged, file) as Record<string, unknown>,
    {},
  ) as T;
