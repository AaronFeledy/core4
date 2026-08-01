import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const corePackagePath = resolve(repoRoot, "core/package.json");

describe("OCLIF version pins", () => {
  test("pins @oclif/core and the oclif CLI to their locked v4 ranges", async () => {
    // Given: the core package manifest is the single place OCLIF versions are declared.
    const corePackage = JSON.parse(await Bun.file(corePackagePath).text()) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    // When/Then: both ranges stay on the locked v4 majors.
    expect(corePackage.dependencies?.["@oclif/core"]).toBe("^4.11.2");
    expect(corePackage.devDependencies?.oclif).toBe("^4.23.0");
  });
});
