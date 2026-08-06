import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { BOUNDARY_RULES } from "../../../../scripts/boundary/registry.ts";
import {
  ALL_PACKAGE_SOURCE_ROOTS,
  ALL_PACKAGE_WALK_ROOTS,
  CORE_AND_PLUGIN_SOURCE_ROOTS,
  NON_PLUGIN_SOURCE_ROOTS,
} from "../../../../scripts/boundary/workspace-roots.ts";
import * as deprecations from "../../../../scripts/check-deprecations.ts";
import * as telemetryInventory from "../../../../scripts/check-telemetry-inventory.ts";

const repoRoot = resolve(import.meta.dir, "../../../..");

/** Rules that are narrow by design and deliberately excluded from the shared source-root tiers. */
const NARROW_BY_DESIGN: ReadonlyMap<string, readonly string[]> = new Map([
  ["libpod-prefix", ["plugins"]],
  ["env-helper", ["plugins/service-lando/src/services"]],
  ["state-store", ["core/src", "plugins"]],
]);

const CORE_AND_PLUGIN_RULE_IDS = [
  "machine-output",
  "managed-file",
  "network",
  "probe",
  "redaction",
  "renderer",
] as const;

const ALL_PACKAGE_RULE_IDS = ["import-cycle", "generated-output"] as const;

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

    // Then: known package families and every discovered source tree are covered
    expect(packagesWithSource).toEqual(
      expect.arrayContaining(["core", "sdk", "container-runtime", "paths", "state-store"]),
    );
    expect(packagesWithSource.some((dir) => dir.startsWith("plugins/"))).toBe(true);
    for (const dir of packagesWithSource) {
      const sourcePath = `${dir}/src`;
      const covered = ALL_PACKAGE_SOURCE_ROOTS.some((root) => rootCoversPath(root, sourcePath));
      expect(covered).toBe(true);
    }
  });

  test("reserves the future landofile and engine source roots", () => {
    // Given / When / Then
    expect(ALL_PACKAGE_SOURCE_ROOTS).toEqual(expect.arrayContaining(["landofile/src", "engine/src"]));
    expect(NON_PLUGIN_SOURCE_ROOTS).toEqual(expect.arrayContaining(["landofile/src", "engine/src"]));
  });

  test("covers Landofile implementation code with shared runtime behavior gates", () => {
    // Given / When / Then
    expect(CORE_AND_PLUGIN_SOURCE_ROOTS).toContain("landofile/src");
    expect(ALL_PACKAGE_WALK_ROOTS).toContain("landofile/src");
  });

  test("classifies narrow-by-design rules with their exact current roots", () => {
    // Given: rules that are deliberately scoped narrower than the shared tiers
    for (const [id, expectedRoots] of NARROW_BY_DESIGN) {
      // When: reading the rule's declared scope from the live registry
      const rule = BOUNDARY_RULES.get(id);

      // Then: it exists and its roots match the documented narrow allowlist exactly
      expect(rule).toBeDefined();
      expect(rule?.scope.roots).toEqual(expectedRoots);
    }
  });

  test("routes runtime boundary rules through the core-and-plugin source tier", () => {
    // Given: residual rules whose behavior applies across every shipped runtime source tier
    for (const id of CORE_AND_PLUGIN_RULE_IDS) {
      // When: reading each rule's declared scope from the live registry
      const rule = BOUNDARY_RULES.get(id);

      // Then: every scope consumes the shared core-and-plugin roots exactly
      expect(rule).toBeDefined();
      expect(rule?.scope.roots).toEqual(CORE_AND_PLUGIN_SOURCE_ROOTS);
    }
  });

  test("routes the paths rule through the shared runtime tier minus its owner", () => {
    // Given: the shared shipped-runtime tier and the package that owns path construction
    const expectedRoots = CORE_AND_PLUGIN_SOURCE_ROOTS.filter((root) => root !== "paths/src");

    // When: reading the paths rule's declared scope from the live registry
    const rule = BOUNDARY_RULES.get("paths");

    // Then: every shared runtime consumer remains covered except the owning implementation
    expect(rule).toBeDefined();
    expect(rule?.scope.roots).toEqual(expectedRoots);
  });

  test("routes package-wide boundary rules through the all-package source tier", () => {
    // Given: the rules that inspect every first-party package source tree
    for (const id of ALL_PACKAGE_RULE_IDS) {
      // When: reading each rule's declared scope from the live registry
      const rule = BOUNDARY_RULES.get(id);

      // Then: every scope consumes the shared all-package roots exactly
      expect(rule).toBeDefined();
      expect(rule?.scope.roots).toEqual(ALL_PACKAGE_SOURCE_ROOTS);
    }
  });

  test("routes the package DAG rule through workspace manifests and package sources", () => {
    // Given / When
    const rule = BOUNDARY_RULES.get("package-dag");

    // Then
    expect(rule?.scope.roots).toEqual(["."]);
    expect(rule?.scope.extensions).toEqual([".json", ".ts", ".tsx", ".mts", ".cts"]);
  });

  test("policies the reverse-direction tier as the all-package tier minus plugins", () => {
    // Given
    const expectedRoots: readonly string[] = ALL_PACKAGE_SOURCE_ROOTS.filter(
      (root) => !root.startsWith("plugins/"),
    );
    const actualRoots: readonly string[] = NON_PLUGIN_SOURCE_ROOTS;

    // When / Then
    expect(actualRoots).toEqual(expectedRoots);
  });

  test("routes walk-based gates through the shared plain-directory roots", () => {
    // Given: the two gates that recursively walk plain directories
    const gateModules = [telemetryInventory, deprecations];

    // When: reading their exported scan-root declarations
    // Then: both gates consume the shared walk roots exactly
    for (const gateModule of gateModules) {
      expect(gateModule).toMatchObject({ SCANNED_ROOTS: ALL_PACKAGE_WALK_ROOTS });
    }
  });
});
