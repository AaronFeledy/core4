import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { scanModuleEdges } from "../../../scripts/module-edge-scan.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const EFFECT_VERSION = "4.0.0";
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

interface PackageManifest {
  readonly name?: string;
  readonly workspaces?: unknown;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
}

const readManifest = async (path: string): Promise<PackageManifest> =>
  JSON.parse(await Bun.file(path).text()) as PackageManifest;

const rootManifest = await readManifest(resolve(repoRoot, "package.json"));
const workspaceGlobs = (rootManifest.workspaces as { packages?: ReadonlyArray<string> } | undefined)?.packages ?? [];

const workspaceDirs = async (): Promise<ReadonlyArray<string>> => {
  const dirs: string[] = [];
  for (const pattern of workspaceGlobs) {
    for await (const match of new Bun.Glob(`${pattern}/package.json`).scan({ cwd: repoRoot, onlyFiles: true })) {
      dirs.push(match.slice(0, -"/package.json".length));
    }
  }
  return dirs.sort();
};

const importsEffect = async (dir: string): Promise<boolean> => {
  const cwd = resolve(repoRoot, dir);
  for await (const path of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd, absolute: true, onlyFiles: true })) {
    if (path.includes("/node_modules/") || path.includes("/dist/")) continue;
    const source = await Bun.file(path).text();
    if (!source.includes("effect")) continue;
    if (scanModuleEdges(path, source).some((edge) => edge.specifier === "effect" || edge.specifier.startsWith("effect/"))) {
      return true;
    }
  }
  return false;
};

describe("Effect version pin", () => {
  test("root workspaces use the object form with an exact effect catalog entry", () => {
    // Given: the root manifest owns the single Effect version.
    const workspaces = rootManifest.workspaces as { packages?: unknown; catalog?: Record<string, string> } | undefined;

    // Then: the catalog pins exactly one Effect release and lists workspace packages.
    expect(Array.isArray(workspaces?.packages)).toBe(true);
    expect(workspaces?.catalog?.effect).toBe(EFFECT_VERSION);
  });

  test("the TypeScript devDependency floor is ^5.9.0", () => {
    expect(rootManifest.devDependencies?.typescript).toBe("^5.9.0");
  });

  test("every workspace declares effect through the catalog and depends on no @effect package", async () => {
    // Given: every workspace manifest, including the root.
    const offenders: string[] = [];
    const missing: string[] = [];
    const dirs = await workspaceDirs();
    expect(dirs.length).toBeGreaterThan(0);

    for (const dir of [".", ...dirs]) {
      const manifest = await readManifest(resolve(repoRoot, dir, "package.json"));
      let declared = false;
      for (const field of DEPENDENCY_FIELDS) {
        for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
          // When: an effect or @effect/* dependency is declared anywhere.
          if (name.startsWith("@effect/")) offenders.push(`${dir} ${field}.${name}`);
          if (name === "effect") {
            declared = true;
            if (specifier !== "catalog:") offenders.push(`${dir} ${field}.effect=${specifier}`);
          }
        }
      }
      if (dir !== "." && !declared && (await importsEffect(dir))) missing.push(dir);
    }

    // Then: only the catalog specifier is used, and no workspace imports effect undeclared.
    expect(offenders).toEqual([]);
    expect(missing).toEqual([]);
  });

  test("the installed effect matches the catalog pin", async () => {
    const installed = await readManifest(resolve(repoRoot, "node_modules/effect/package.json"));
    expect((installed as { version?: string }).version).toBe(EFFECT_VERSION);
  });
});
