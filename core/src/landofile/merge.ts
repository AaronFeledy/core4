/**
 * Landofile merge semantics.
 *
 * Default load order (low → high precedence):
 *   1. .lando.base.yml
 *   2. .lando.dist.yml
 *   3. .lando.recipe.yml
 *   4. .lando.upstream.yml
 *   5. .lando.yml          (canonical; filename configurable globally)
 *   6. .lando.local.yml
 *   7. .lando.user.yml
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
 * Status: stub.
 */

export const DEFAULT_PRE_LANDOFILES = [
  ".lando.base.yml",
  ".lando.dist.yml",
  ".lando.recipe.yml",
  ".lando.upstream.yml",
] as const;

export const DEFAULT_LANDOFILE = ".lando.yml" as const;

export const DEFAULT_POST_LANDOFILES = [".lando.local.yml", ".lando.user.yml"] as const;

/**
 * Identity keys for array-of-objects merge.
 */
export const ARRAY_IDENTITY_KEYS = ["name", "id", "hostname", "service"] as const;

/**
 * TODO: implement deep merge with array identity rules.
 */
export const mergeLandofiles = <T extends Record<string, unknown>>(files: ReadonlyArray<T>): T => {
  void files;
  throw new Error("mergeLandofiles: not yet implemented");
};
