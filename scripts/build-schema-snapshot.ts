#!/usr/bin/env bun
/**
 * Regenerate the public schema snapshot used by the CI drift gate.
 *
 * Scope:
 *   - JSON Schema output for the public `@lando/sdk/schema` registry
 *   - committed standalone schema artifacts generated from that registry
 *   - decoded manifests for the in-binary bundled plugins only
 *
 * Out-of-tree plugin manifests are intentionally not discovered here.
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { Schema } from "effect";

import { BUNDLED_PLUGINS } from "../core/src/plugins/bundled.ts";
import {
  JSON_SCHEMA_NAMES,
  PluginManifest,
  assertJsonSchemaDeprecationsValid,
  assertPublicSchemaAnnotations,
  getJsonSchema,
  publicSchemaMetadataIndex,
  schemaArtifactFilename,
} from "../sdk/src/schema/index.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(REPO_ROOT, "sdk/test/fixtures/schema-snapshot.json");
const SCHEMA_ARTIFACT_DIR = resolve(REPO_ROOT, "dist/schemas");

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
};

const generateJsonSchema = (schemaName: (typeof JSON_SCHEMA_NAMES)[number]): unknown => {
  try {
    return getJsonSchema(schemaName);
  } catch (cause) {
    throw new Error(`Failed to generate JSON Schema for ${schemaName}.`, { cause });
  }
};

const renderSnapshot = (): string => {
  assertPublicSchemaAnnotations();
  const sdkSchemas = Object.fromEntries(
    JSON_SCHEMA_NAMES.map((schemaName) => [schemaName, stable(generateJsonSchema(schemaName))]),
  );
  for (const [schemaName, jsonSchema] of Object.entries(sdkSchemas)) {
    const invalidPaths = assertJsonSchemaDeprecationsValid(jsonSchema);
    if (invalidPaths.length > 0) {
      throw new Error(`${schemaName} emits invalid x-deprecation payloads at ${invalidPaths.join(", ")}`);
    }
  }
  const bundledPluginManifests = BUNDLED_PLUGINS.map((plugin) => ({
    name: plugin.name,
    manifest: stable(Schema.encodeSync(PluginManifest)(plugin.manifest)),
  })).sort((left, right) => left.name.localeCompare(right.name));

  return `${JSON.stringify(
    stable({
      generatedBy: "scripts/build-schema-snapshot.ts",
      scope: {
        sdkSchemas: JSON_SCHEMA_NAMES,
        schemaMetadata: "dist/schemas/index.json",
        bundledPluginManifests: bundledPluginManifests.map((plugin) => plugin.name),
      },
      schemaMetadata: publicSchemaMetadataIndex,
      sdkSchemas,
      bundledPluginManifests,
    }),
    null,
    2,
  )}\n`;
};

const main = async (): Promise<void> => {
  await Bun.write(OUTPUT, renderSnapshot());
  await mkdir(SCHEMA_ARTIFACT_DIR, { recursive: true });
  const metadataIndexPath = resolve(SCHEMA_ARTIFACT_DIR, "index.json");
  await Bun.write(metadataIndexPath, `${JSON.stringify(stable(publicSchemaMetadataIndex), null, 2)}\n`);
  const artifactPaths: string[] = [metadataIndexPath];
  for (const schemaName of JSON_SCHEMA_NAMES) {
    const artifactPath = resolve(SCHEMA_ARTIFACT_DIR, schemaArtifactFilename(schemaName));
    artifactPaths.push(artifactPath);
    await Bun.write(artifactPath, `${JSON.stringify(stable(generateJsonSchema(schemaName)), null, 2)}\n`);
  }

  const check = Bun.spawn({
    cmd: [process.execPath, "x", "biome", "check", "--write", OUTPUT, ...artifactPaths],
    cwd: REPO_ROOT,
    stdout: "ignore",
    stderr: "inherit",
  });
  const exitCode = await check.exited;
  if (exitCode !== 0) {
    throw new Error(`biome check exited with code ${exitCode} for generated schema artifacts`);
  }

  console.log(`[build-schema-snapshot] wrote ${OUTPUT}`);
};

await main();
