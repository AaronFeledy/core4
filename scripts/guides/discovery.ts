import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const isNotFound = (cause: unknown): boolean =>
  cause !== null && typeof cause === "object" && "code" in cause && cause.code === "ENOENT";
const walkMdx = async (root: string, dir: string): Promise<ReadonlyArray<string>> => {
  let entries: Dirent[];
  try {
    entries = await readdir(resolve(root, dir), { withFileTypes: true });
  } catch (cause) {
    if (isNotFound(cause)) return [];
    throw cause;
  }
  const files = await Promise.all(
    entries.map(async (entry) => {
      const child = `${dir}/${entry.name}`;
      return entry.isDirectory()
        ? walkMdx(root, child)
        : entry.isFile() && entry.name.endsWith(".mdx")
          ? [child]
          : [];
    }),
  );
  return files.flat().sort((a, b) => a.localeCompare(b));
};
const discoverRecipeReadmes = async (root: string): Promise<ReadonlyArray<string>> => {
  let entries: Dirent[];
  try {
    entries = await readdir(resolve(root, "recipes"), { withFileTypes: true });
  } catch (cause) {
    if (isNotFound(cause)) return [];
    throw cause;
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `recipes/${entry.name}/README.mdx`);
  const existing = await Promise.all(
    candidates.map(async (path) => ((await Bun.file(resolve(root, path)).exists()) ? path : undefined)),
  );
  return existing.filter((path): path is string => path !== undefined);
};
export const discoverGuideMdxFiles = async (root = REPO_ROOT): Promise<ReadonlyArray<string>> => {
  const [guides, recipes] = await Promise.all([walkMdx(root, "docs/guides"), discoverRecipeReadmes(root)]);
  return [...guides, ...recipes].sort((a, b) => a.localeCompare(b));
};

/** Fixtures for a guide id resolve here for every guide with that id. */
export const guideFixturesRoot = (guideId: string): string => `docs/guides/${guideId}/fixtures/`;

/**
 * The one predicate for "this path touches this guide": the guide's MDX or a
 * file under its fixture directory. A case file touches nothing until cases
 * compile.
 */
export const pathTouchesGuide = (
  path: string,
  guide: { readonly guidePath: string; readonly guideId?: string },
): boolean => {
  if (path.endsWith(".cases.ts")) return false;
  if (path === guide.guidePath) return true;
  return guide.guideId !== undefined && path.startsWith(guideFixturesRoot(guide.guideId));
};
