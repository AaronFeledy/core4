import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "bun:test";

import type { ContributionRef } from "@lando/sdk/schema";

const repoRoot = resolve(import.meta.dirname, "../../..");
const expectedNativeOutput = resolve(repoRoot, "core/src/cli/generated/setup-plugin-flags.ts");
const generatorPath = resolve(repoRoot, "scripts/build-setup-plugin-flags.ts");
const fixtureFiles = [
  "package.json",
  "biome.json",
  "core/build.config.ts",
  "scripts/_codegen-output.ts",
  "scripts/build-setup-plugin-flags.ts",
] as const;
type SetupPluginFlagsGenerator = {
  readonly contributionId: (entry: ContributionRef) => string;
  readonly SETUP_PLUGIN_FLAGS_OUTPUT: string;
};
const isSetupPluginFlagsGenerator = (value: unknown): value is SetupPluginFlagsGenerator =>
  typeof value === "object" &&
  value !== null &&
  "contributionId" in value &&
  typeof value.contributionId === "function" &&
  "SETUP_PLUGIN_FLAGS_OUTPUT" in value &&
  typeof value.SETUP_PLUGIN_FLAGS_OUTPUT === "string";
const importedGenerator: unknown = await import(pathToFileURL(generatorPath).href);
if (!isSetupPluginFlagsGenerator(importedGenerator)) {
  throw new TypeError("setup plugin flag generator exports are incomplete");
}
const { contributionId, SETUP_PLUGIN_FLAGS_OUTPUT } = importedGenerator;

describe("build-setup-plugin-flags contributionId", () => {
  test("passes through a plain provider id string", () => {
    expect(contributionId("docker")).toBe("docker");
  });

  test("extracts the id from a deprecated ContributionRef object", () => {
    expect(
      contributionId({
        id: "legacy-docker",
        deprecated: { since: "4.0.0", note: "renamed", removeIn: "5.0.0", severity: "warn" },
      }),
    ).toBe("legacy-docker");
  });

  test("exports the native output path", () => {
    expect(SETUP_PLUGIN_FLAGS_OUTPUT).toBe(expectedNativeOutput);
  });

  test("writes the native output", async () => {
    // Given
    const fixtureRoot = await mkdtemp(join(tmpdir(), "lando-setup-plugin-flags-"));
    try {
      await Promise.all(
        fixtureFiles.map(async (path) => {
          const destination = resolve(fixtureRoot, path);
          await mkdir(dirname(destination), { recursive: true });
          await cp(resolve(repoRoot, path), destination);
        }),
      );
      await symlink(resolve(repoRoot, "node_modules"), resolve(fixtureRoot, "node_modules"), "dir");

      const fixtureGenerator = resolve(fixtureRoot, "scripts/build-setup-plugin-flags.ts");
      const fixtureNativeOutput = resolve(fixtureRoot, "core/src/cli/generated/setup-plugin-flags.ts");
      expect(await Bun.file(fixtureNativeOutput).exists()).toBe(false);

      // When
      const proc = Bun.spawnSync([process.execPath, fixtureGenerator], {
        cwd: fixtureRoot,
        stdout: "pipe",
        stderr: "pipe",
      });

      // Then
      expect({
        exitCode: proc.exitCode,
        stderr: proc.stderr.toString(),
      }).toMatchObject({ exitCode: 0 });
      expect(await Bun.file(fixtureNativeOutput).text()).toContain("BUNDLED_SETUP_FLAG_CONTRIBUTIONS");
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });
});
