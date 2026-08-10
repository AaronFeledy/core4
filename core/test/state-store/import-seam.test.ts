import { describe, expect, test } from "bun:test";
import { readdirSync, realpathSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";

import { type ModuleEdge, scanModuleEdges } from "../../../scripts/module-edge-scan.ts";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const legacyModules = [
  "core/src/state/service.ts",
  "core/src/state/lock.ts",
  "core/src/state/paths.ts",
  "core/src/state/codec.ts",
  "core/src/state-store/atomic.ts",
] as const;
const legacyModulePaths = new Set(legacyModules.map((path) => resolve(repositoryRoot, path)));
const typeScriptExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const skippedDirectories = new Set([".codegraph", ".git", ".omo", "coverage", "dist", "node_modules"]);

// The legacy shims are deleted; no importer, edge kind, or specifier is exempt.
const legacyIdentityAllowlist = new Set<string>([]);

const repoRelative = (path: string): string => relative(repositoryRoot, path).replaceAll("\\", "/");

const collectTypeScriptFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) return [];
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(path);
    return entry.isFile() && typeScriptExtensions.has(extname(entry.name)) ? [path] : [];
  });

const resolveModuleEdge = (importer: string, specifier: string): string | undefined => {
  try {
    return resolve(Bun.resolveSync(specifier, dirname(importer)));
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
};

const isAllowedLegacyIdentityImport = (importer: string, edge: ModuleEdge): boolean =>
  legacyIdentityAllowlist.has(`${repoRelative(importer)}|${edge.kind}|${edge.specifier}`);

describe("StateStore import seam", () => {
  test("reports every first-party consumer of a legacy StateStore module", async () => {
    // Given every first-party TypeScript source, including production, tests, plugins,
    // scripts, and generated source roots, with build and dependency trees excluded
    const files = [...collectTypeScriptFiles(repositoryRoot)].sort();

    // When import-shaped AST edges are resolved to their concrete modules
    const offenders = (
      await Promise.all(
        files.map(async (importer) => {
          const edges = scanModuleEdges(importer, await Bun.file(importer).text());
          return edges.flatMap((edge) => {
            const resolved = resolveModuleEdge(importer, edge.specifier);
            if (
              resolved === undefined ||
              !legacyModulePaths.has(resolved) ||
              isAllowedLegacyIdentityImport(importer, edge)
            ) {
              return [];
            }
            return [
              `${repoRelative(importer)}:${edge.line}: ${edge.kind} ${JSON.stringify(edge.specifier)} -> ${repoRelative(resolved)}`,
            ];
          });
        }),
      )
    ).flat();

    // Then the complete, stable offender list is empty after package-seam migration
    expect(offenders.sort().join("\n")).toBe("");
  });

  test("renders the minimal layer with the StateStore package service import", async () => {
    // Given the minimal bootstrap-layer renderer
    const renderers: unknown = await import(resolve(repositoryRoot, "scripts/bootstrap-layer-renderers.ts"));
    if (
      typeof renderers !== "object" ||
      renderers === null ||
      !("renderMinimal" in renderers) ||
      typeof renderers.renderMinimal !== "function"
    ) {
      throw new TypeError("bootstrap-layer-renderers.ts must export renderMinimal");
    }
    const source = renderers.renderMinimal();

    // When its import-shaped AST edges are scanned
    const imports = new Set(scanModuleEdges("minimal.ts", source).map((edge) => edge.specifier));

    // Then it emits the package service import and omits the legacy relative service import
    expect({
      legacyServiceImport: imports.has("../../../state/service.ts"),
      packageServiceImport: imports.has("@lando/state-store/service"),
    }).toEqual({ legacyServiceImport: false, packageServiceImport: true });
  });

  test("resolves the StateStore package service from provider test directories", () => {
    // Given both provider test directories that consume the private package seam
    const providerTestDirectories = [
      ["provider-lando", resolve(repositoryRoot, "plugins/provider-lando/test")],
      ["provider-podman", resolve(repositoryRoot, "plugins/provider-podman/test")],
    ] as const;

    // When Bun resolves the service subpath from each provider
    const resolutions = providerTestDirectories.map(
      ([provider, directory]) =>
        `${provider}: ${repoRelative(realpathSync(Bun.resolveSync("@lando/state-store/service", directory)))}`,
    );

    // Then both package resolutions reach the StateStore implementation source
    expect(resolutions).toEqual([
      "provider-lando: state-store/src/service.ts",
      "provider-podman: state-store/src/service.ts",
    ]);
  });
});
