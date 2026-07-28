import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { BOUNDARY_RULES } from "../../../../scripts/boundary/registry.ts";
import { ALL_PACKAGE_SOURCE_ROOTS } from "../../../../scripts/boundary/workspace-roots.ts";

const repoRoot = resolve(import.meta.dir, "../../../..");

/** Rules that are narrow by design and deliberately excluded from the shared source-root tiers. */
const NARROW_BY_DESIGN: ReadonlyMap<string, readonly string[]> = new Map([
  ["libpod-prefix", ["plugins"]],
  ["env-helper", ["plugins/service-lando/src/services"]],
]);

/** True when `path`'s segments match `root`'s segments, treating a `*` root segment as a wildcard. */
const rootCoversPath = (root: string, path: string): boolean => {
  const rootSegments = root.split("/");
  const pathSegments = path.split("/");
  if (rootSegments.length !== pathSegments.length) return false;
  return rootSegments.every((segment, index) => segment === "*" || segment === pathSegments[index]);
};

const workspacePackageDirs = async (): Promise<readonly string[]> => {
  const rootManifest: unknown = await Bun.file(resolve(repoRoot, "package.json")).json();
  const workspaces =
    typeof rootManifest === "object" && rootManifest !== null && "workspaces" in rootManifest
      ? (rootManifest as { workspaces: readonly string[] }).workspaces
      : [];
  const dirs: string[] = [];
  for (const workspace of workspaces) {
    if (!workspace.endsWith("/*")) {
      dirs.push(workspace);
      continue;
    }
    const globRoot = workspace.slice(0, -2);
    const entries = await readdir(resolve(repoRoot, globRoot), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(`${globRoot}/${entry.name}`);
    }
  }
  return dirs;
};

describe("workspace source-root drift gate", () => {
  test("covers every workspace package's src/ tree in ALL_PACKAGE_SOURCE_ROOTS", async () => {
    // Given: every package.json workspace entry, with `plugins/*` expanded against disk
    const packageDirs = await workspacePackageDirs();

    // When: filtering to packages that actually have a src/ tree
    const packagesWithSource = packageDirs.filter((dir) => existsSync(resolve(repoRoot, dir, "src")));

    // Then: at least the four known package families are present, and each is
    // matched by some root in ALL_PACKAGE_SOURCE_ROOTS — this is the assertion
    // that goes red the moment a new top-level package (e.g. `paths/`) gains a
    // src/ tree without extending the shared constants.
    expect(packagesWithSource).toEqual(expect.arrayContaining(["core", "sdk", "container-runtime"]));
    expect(packagesWithSource.some((dir) => dir.startsWith("plugins/"))).toBe(true);
    for (const dir of packagesWithSource) {
      const sourcePath = `${dir}/src`;
      const covered = ALL_PACKAGE_SOURCE_ROOTS.some((root) => rootCoversPath(root, sourcePath));
      expect(covered).toBe(true);
    }
  });

  test("classifies libpod-prefix and env-helper as narrow-by-design with their exact current roots", () => {
    // Given: the two rules that are deliberately scoped narrower than the shared tiers
    for (const [id, expectedRoots] of NARROW_BY_DESIGN) {
      // When: reading the rule's declared scope from the live registry
      const rule = BOUNDARY_RULES.get(id);

      // Then: it exists and its roots match the documented narrow allowlist exactly
      expect(rule).toBeDefined();
      expect(rule?.scope.roots).toEqual(expectedRoots);
    }
  });
});
