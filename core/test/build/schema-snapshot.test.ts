import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import type { JsonSchemaName } from "../../../sdk/src/schema/index.ts";

import {
  JSON_SCHEMA_NAMES,
  publicSchemaMetadataIndex,
  publicSchemaRegistry,
  renderPublicSchemaReferencePages,
  schemaArtifactFilename,
} from "../../../sdk/src/schema/index.ts";
import { BUNDLED_PLUGINS } from "../../src/plugins/bundled.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const snapshotPath = resolve(repoRoot, "sdk/test/fixtures/schema-snapshot.json");
const generatorPath = resolve(repoRoot, "scripts/build-schema-snapshot.ts");
const deprecationNoticeArtifactPath = resolve(repoRoot, "dist/schemas/deprecation-notice.json");
const metadataIndexPath = resolve(repoRoot, "dist/schemas/index.json");

const schemaArtifactPath = (schemaName: JsonSchemaName): string =>
  resolve(repoRoot, "dist/schemas", schemaArtifactFilename(schemaName));

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

  test("public registry drives schema names and metadata index", async () => {
    runGenerator();

    const generated = JSON.parse(
      await readFile(metadataIndexPath, "utf8"),
    ) as typeof publicSchemaMetadataIndex;

    expect(Object.keys(publicSchemaRegistry)).toEqual(JSON_SCHEMA_NAMES);
    expect(generated).toEqual(publicSchemaMetadataIndex);
    expect(generated.map((entry) => entry.id)).toEqual(JSON_SCHEMA_NAMES);
    expect(generated.find((entry) => entry.id === "DeprecationNotice")).toMatchObject({
      title: "Deprecation Notice",
      packageExport: "@lando/sdk/schema#DeprecationNotice",
      jsonSchemaPath: "dist/schemas/deprecation-notice.json",
      docsPath: "docs/reference/schemas/deprecation-notice.mdx",
      deprecated: false,
    });
  });

  test("public registry drives generated reference page inputs", () => {
    const pages = renderPublicSchemaReferencePages();

    expect(pages.map((page) => page.id)).toEqual(JSON_SCHEMA_NAMES);
    expect(pages.map((page) => page.docsPath)).toEqual(
      publicSchemaMetadataIndex.map((entry) => entry.docsPath),
    );
    expect(pages.find((page) => page.id === "DeprecationNotice")).toMatchObject({
      docsPath: "docs/reference/schemas/deprecation-notice.mdx",
      content: expect.stringContaining("# Deprecation Notice"),
    });
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
