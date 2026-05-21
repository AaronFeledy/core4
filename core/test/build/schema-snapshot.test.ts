import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { BUNDLED_PLUGINS } from "../../src/plugins/bundled.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const snapshotPath = resolve(repoRoot, "sdk/test/fixtures/schema-snapshot.json");
const generatorPath = resolve(repoRoot, "scripts/build-schema-snapshot.ts");

const runGenerator = (): void => {
  const proc = Bun.spawnSync([process.execPath, generatorPath], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect({
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  }).toMatchObject({ exitCode: 0 });
};

describe("schema snapshot gate", () => {
  test("generator is idempotent", async () => {
    const before = await readFile(snapshotPath, "utf8");

    runGenerator();

    expect(await readFile(snapshotPath, "utf8")).toBe(before);
  });

  test("snapshot scope is SDK schemas plus bundled plugin manifests", async () => {
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as {
      readonly scope: {
        readonly sdkSchemas: ReadonlyArray<string>;
        readonly bundledPluginManifests: ReadonlyArray<string>;
      };
      readonly sdkSchemas: Record<string, unknown>;
      readonly bundledPluginManifests: ReadonlyArray<{ readonly name: string }>;
    };

    expect(Object.keys(snapshot.sdkSchemas).sort()).toEqual([...snapshot.scope.sdkSchemas].sort());
    expect(snapshot.scope.sdkSchemas).toContain("PluginManifest");
    expect(snapshot.scope.sdkSchemas).toContain("AppPlan");

    const bundledNames = BUNDLED_PLUGINS.map((plugin) => plugin.name).sort();
    expect(snapshot.scope.bundledPluginManifests).toEqual(bundledNames);
    expect(snapshot.bundledPluginManifests.map((plugin) => plugin.name).sort()).toEqual(bundledNames);
  });
});
