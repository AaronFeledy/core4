import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { JSON_SCHEMA_NAMES } from "../../../sdk/src/schema/index.ts";
import { BUNDLED_PLUGINS } from "../../src/plugins/bundled.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const snapshotPath = resolve(repoRoot, "sdk/test/fixtures/schema-snapshot.json");
const generatorPath = resolve(repoRoot, "scripts/build-schema-snapshot.ts");
const deprecationNoticeArtifactPath = resolve(repoRoot, "dist/schemas/deprecation-notice.json");

const schemaArtifactPath = (schemaName: string): string =>
  resolve(
    repoRoot,
    "dist/schemas",
    `${schemaName
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
      .toLowerCase()}.json`,
  );

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
    expect(snapshot.scope.sdkSchemas).toContain("DeprecationNotice");
    expect(snapshot.scope.sdkSchemas).toContain("AppPlan");
    expect(snapshot.scope.sdkSchemas).toEqual(JSON_SCHEMA_NAMES);
    expect(snapshot.scope.sdkSchemas).toContain("ServiceConfig");
    expect(snapshot.scope.sdkSchemas).toContain("ExpressionTemplate");
    expect(snapshot.scope.sdkSchemas).toContain("LandofileExpressionParseError");
    expect(snapshot.scope.sdkSchemas).toContain("LandoEvent");

    const bundledNames = BUNDLED_PLUGINS.map((plugin) => plugin.name).sort();
    expect(snapshot.scope.bundledPluginManifests).toEqual(bundledNames);
    expect(snapshot.bundledPluginManifests.map((plugin) => plugin.name).sort()).toEqual(bundledNames);
  });

  test("generator emits the deprecation notice schema artifact", async () => {
    runGenerator();

    const artifact = JSON.parse(await readFile(deprecationNoticeArtifactPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(artifact.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(JSON.stringify(artifact)).toContain("Deprecation Notice");
  });

  test("generator emits a draft-07 schema artifact for every public SDK schema", async () => {
    runGenerator();

    for (const schemaName of JSON_SCHEMA_NAMES) {
      const artifact = JSON.parse(await readFile(schemaArtifactPath(schemaName), "utf8")) as Record<
        string,
        unknown
      >;

      expect(artifact.$schema, schemaName).toBe("http://json-schema.org/draft-07/schema#");
    }
  });
});
