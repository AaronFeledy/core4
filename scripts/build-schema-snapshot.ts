#!/usr/bin/env bun
/**
 * Regenerate the public schema snapshot used by the CI drift gate.
 *
 * Scope:
 *   - JSON Schema output for the public `@lando/sdk/schema` registry
 *   - decoded manifests for the in-binary bundled plugins only
 *
 * Out-of-tree plugin manifests are intentionally not discovered here.
 */
import { resolve } from "node:path";

import { Schema } from "effect";

import { BUNDLED_PLUGINS } from "../core/src/plugins/bundled.ts";
import { type JsonSchemaName, PluginManifest, getJsonSchema } from "../sdk/src/schema/index.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(REPO_ROOT, "sdk/test/fixtures/schema-snapshot.json");

const SDK_SCHEMA_NAMES = [
  "DeprecationNotice",
  "GuideFrontmatter",
  "GuideProps",
  "ScenarioProps",
  "StepProps",
  "RunProps",
  "VerifyProps",
  "CleanupProps",
  "VariableProps",
  "HiddenProps",
  "InspectProps",
  "TabsProps",
  "TabProps",
  "UseFixtureProps",
  "MatcherSchema",
  "Transcript",
  "BootstrapLevel",
  "AppRef",
  "AppPlan",
  "ServicePlan",
  "ProviderCapabilities",
  "LandofileShape",
  "GlobalConfig",
  "AppId",
  "ServiceName",
  "ProviderId",
  "HostPlatform",
  "ServiceInfo",
  "PluginManifest",
  "GlobalServiceContribution",
  "FileSyncEngineCapabilities",
  "FileSyncSessionSpec",
  "FileSyncSessionInfo",
  "FileSyncEventChunk",
  "FileSyncPlan",
] as const satisfies ReadonlyArray<JsonSchemaName>;

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
};

const renderSnapshot = (): string => {
  const sdkSchemas = Object.fromEntries(
    SDK_SCHEMA_NAMES.map((schemaName) => [schemaName, stable(getJsonSchema(schemaName))]),
  );
  const bundledPluginManifests = BUNDLED_PLUGINS.map((plugin) => ({
    name: plugin.name,
    manifest: stable(Schema.encodeSync(PluginManifest)(plugin.manifest)),
  })).sort((left, right) => left.name.localeCompare(right.name));

  return `${JSON.stringify(
    stable({
      generatedBy: "scripts/build-schema-snapshot.ts",
      scope: {
        sdkSchemas: SDK_SCHEMA_NAMES,
        bundledPluginManifests: bundledPluginManifests.map((plugin) => plugin.name),
      },
      sdkSchemas,
      bundledPluginManifests,
    }),
    null,
    2,
  )}\n`;
};

const main = async (): Promise<void> => {
  await Bun.write(OUTPUT, renderSnapshot());

  const check = Bun.spawn({
    cmd: [process.execPath, "x", "biome", "check", "--write", OUTPUT],
    cwd: REPO_ROOT,
    stdout: "ignore",
    stderr: "inherit",
  });
  const exitCode = await check.exited;
  if (exitCode !== 0) {
    throw new Error(`biome check exited with code ${exitCode} for ${OUTPUT}`);
  }

  console.log(`[build-schema-snapshot] wrote ${OUTPUT}`);
};

await main();
