import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { scanModuleEdges } from "../../../scripts/module-edge-scan.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const coreRoot = resolve(repoRoot, "core");
const corePackagePath = resolve(repoRoot, "core/package.json");

describe("OCLIF version pins", () => {
  test("keeps retained OCLIF tooling dev-only at its locked ranges", async () => {
    // Given: the core package manifest is the single place OCLIF versions are declared.
    const corePackage = JSON.parse(await Bun.file(corePackagePath).text()) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    // When: production and development dependency classifications are inspected.
    const productionOclifPackages = Object.keys(corePackage.dependencies ?? {}).filter(
      (name) => name === "oclif" || name.startsWith("@oclif/"),
    );

    // Then: no OCLIF package ships, while retained tooling stays pinned for tests and manifests.
    expect(productionOclifPackages).toEqual([]);
    expect(corePackage.devDependencies?.["@oclif/core"]).toBe("^4.11.2");
    expect(corePackage.devDependencies?.["@oclif/plugin-help"]).toBe("^6.2.48");
    expect(corePackage.devDependencies?.oclif).toBe("^4.23.0");
  });

  test("keeps production TypeScript imports OCLIF-free", async () => {
    // Given: every TypeScript production file shipped by @lando/core.
    const sourceFiles = Array.fromAsync(
      new Bun.Glob("src/**/*.ts").scan({ cwd: coreRoot, absolute: true, onlyFiles: true }),
    );

    // When: direct runtime and type-only OCLIF imports are located.
    const oclifImports: string[] = [];
    for (const path of await sourceFiles) {
      const source = await Bun.file(path).text();
      for (const edge of scanModuleEdges(path, source)) {
        if (edge.specifier === "oclif" || edge.specifier.startsWith("@oclif/")) {
          oclifImports.push(`${path.replace(`${coreRoot}/`, "")}:${edge.line}`);
        }
      }
    }

    // Then: production resolves no import through an external OCLIF package.
    expect(oclifImports).toEqual([]);
  });
});
