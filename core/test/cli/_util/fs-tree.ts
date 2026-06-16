/**
 * Filesystem-tree snapshot helpers for plugin-command containment assertions.
 * No `bun:test` import so in-process scenario tests and spawn-based parity
 * suites can share the same helpers.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/** Relative tree listing; symlinks are leaves (not followed) so link targets stay out of the snapshot. */
export const listTree = (root: string): ReadonlyArray<string> => {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs);
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        walk(abs);
      } else {
        out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
};

export const treeCreatedSince = (
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const seen = new Set(before);
  return after.filter((path) => !seen.has(path));
};

export const pathsOutsidePrefixes = (
  paths: ReadonlyArray<string>,
  allowedPrefixes: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  paths.filter(
    (path) =>
      !allowedPrefixes.some(
        (prefix) => path === prefix || path === `${prefix}/` || path.startsWith(`${prefix}/`),
      ),
  );
