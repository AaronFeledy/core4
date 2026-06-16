/**
 * Filesystem-tree snapshot helpers for plugin-command containment assertions.
 *
 * Test-runner agnostic (no `bun:test` import) so both in-process scenario tests
 * and the spawn-based dispatch-parity suite can prove a command's writes stay
 * within an allowed root (e.g. `<userDataRoot>/plugins/`).
 */
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * List every entry under `root` as paths relative to `root`. Directories carry
 * a trailing `/`; symlinks are recorded as leaves (never traversed) so a linked
 * plugin's target tree does not leak into the snapshot.
 */
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

/** Relative paths present in `after` but not in `before`. */
export const treeCreatedSince = (
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const seen = new Set(before);
  return after.filter((path) => !seen.has(path));
};

/**
 * Relative paths that fall outside every allowed prefix. A prefix matches its
 * own entry (`plugins`/`plugins/`) and any descendant (`plugins/...`).
 */
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
