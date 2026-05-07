/**
 * Path helpers (intentionally tiny; no `node:path` outside the
 * `FileSystem` adapter).
 *
 * Minimal pure helpers that may live in `src/utils/`.
 */

/**
 * Slugify a string for use as a project id, volume name, or container
 * label. Keeps `[a-z0-9-]`, lowercases, collapses runs of `-`.
 *
 * Auto-naming uses kebab-case slugs.
 */
export const slugify = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
