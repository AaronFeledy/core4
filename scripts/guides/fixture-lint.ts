import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { walkAllNodes } from "./editorial-lint.ts";
import { type GuideLintDiagnostic, diagnostic } from "./lint-diagnostic.ts";
import { type MdxNode, elementChildren, propsOf } from "./mdx.ts";

export interface GuideFixtureInventoryEntry {
  readonly name: string;
  readonly sourcePath: string;
  readonly scope: "local" | "shared";
  readonly kind: "directory" | "symlink" | "other";
  readonly symlinkPaths?: ReadonlyArray<string>;
}
const entriesAt = async (path: string): Promise<ReadonlyArray<Dirent<string>>> => {
  try {
    return await readdir(path, { encoding: "utf8", withFileTypes: true });
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
};
const symlinkDescendants = async (root: string, dir: string): Promise<ReadonlyArray<string>> => {
  const paths: string[] = [];
  for (const entry of await entriesAt(resolve(root, dir))) {
    const path = `${dir}/${entry.name}`;
    if (entry.isSymbolicLink()) paths.push(path);
    else if (entry.isDirectory()) paths.push(...(await symlinkDescendants(root, path)));
  }
  return paths;
};
export const buildFixtureInventory = async (
  root: string,
  guideId: string,
  guideRoot = "docs/guides",
): Promise<ReadonlyArray<GuideFixtureInventoryEntry>> => {
  const inventory: GuideFixtureInventoryEntry[] = [];
  const roots = [
    { dir: `${guideRoot}/${guideId}/fixtures`, scope: "local" },
    { dir: `${guideRoot}/fixtures`, scope: "shared" },
  ] as const;
  for (const { dir, scope } of roots) {
    for (const entry of await entriesAt(resolve(root, dir))) {
      const sourcePath = `${dir}/${entry.name}`;
      const kind = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "other";
      const symlinkPaths = kind === "directory" ? await symlinkDescendants(root, sourcePath) : [];
      inventory.push({
        name: entry.name,
        sourcePath,
        scope,
        kind,
        ...(symlinkPaths.length === 0 ? {} : { symlinkPaths }),
      });
    }
  }
  return inventory;
};
export const lintFixtures = (
  sourcePath: string,
  root: MdxNode,
  context: {
    readonly frontmatter: Record<string, unknown>;
    readonly fixtures: ReadonlyArray<GuideFixtureInventoryEntry>;
  },
): ReadonlyArray<GuideLintDiagnostic> => {
  const diagnostics: GuideLintDiagnostic[] = [];
  const references = new Map<string, MdxNode>();
  walkAllNodes(root, (node) => {
    if (node.name !== "UseFixture") return;
    const name = propsOf(node, sourcePath).name;
    if (typeof name === "string" && !references.has(name)) references.set(name, node);
  });
  for (const [name, node] of references) {
    const entries = context.fixtures.filter((entry) => entry.name === name && entry.kind !== "other");
    if (entries.length === 0)
      diagnostics.push(
        diagnostic(
          sourcePath,
          node,
          "guide.fixture.missing",
          `<UseFixture name="${name}"> does not resolve to a fixture directory.`,
        ),
      );
    for (const entry of entries) {
      for (const path of entry.kind === "symlink" ? [entry.sourcePath] : (entry.symlinkPaths ?? []))
        diagnostics.push(
          diagnostic(
            sourcePath,
            node,
            "guide.fixture.symlink",
            `Fixture "${name}" contains a symbolic link at "${path}" and cannot be copied immutably.`,
          ),
        );
    }
  }
  const anchor = elementChildren(root).find((node) => node.name === "Guide") ?? root;
  for (const entry of context.fixtures) {
    if (entry.scope === "local" && entry.kind !== "other" && !references.has(entry.name))
      diagnostics.push(
        diagnostic(
          sourcePath,
          anchor,
          "guide.fixture.unused",
          `Fixture "${entry.name}" is not referenced by any <UseFixture> in guide "${typeof context.frontmatter.id === "string" ? context.frontmatter.id : ""}".`,
        ),
      );
  }
  return diagnostics;
};
