#!/usr/bin/env bun
/**
 * Regenerate the public schema artifact set.
 *
 * Scope:
 *   - JSON Schema output for the public `@lando/sdk/schema` registry
 *   - gitignored derived standalone schema artifacts from that registry
 *   - standalone result schemas for every canonical command
 *   - byte-identical `core/dist/{schemas,command-schemas}` package mirrors for npm packaging
 *   - decoded manifests for the in-binary bundled plugins only
 *
 * Out-of-tree plugin manifests are intentionally not discovered here.
 */
import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { JSONSchema, Schema } from "effect";

import type { LandoCommandSpec } from "../core/src/cli/oclif/command-base.ts";
import compiledCommands from "../core/src/cli/oclif/compiled-commands.ts";
import { BUNDLED_PLUGIN_MODULES } from "../core/src/plugins/generated/bundled.ts";
import {
  JSON_SCHEMA_NAMES,
  PluginManifest,
  assertJsonSchemaDeprecationsValid,
  assertPublicSchemaAnnotations,
  getJsonSchema,
  publicSchemaMetadataIndex,
  renderPublicSchemaReferencePages,
  schemaArtifactFilename,
} from "../sdk/src/schema/index.ts";
import { assertPublicSchemaContractCoverage } from "../sdk/test/schema/public-schema-contracts.ts";
import { formatGeneratedPaths } from "./_codegen-output.ts";
import { mirrorSchemaArtifacts } from "./mirror-schema-artifacts.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const BUNDLED_PLUGIN_MANIFESTS_OUTPUT = resolve(REPO_ROOT, "sdk/test/fixtures/bundled-plugin-manifests.json");
const SCHEMA_ARTIFACT_DIR = resolve(REPO_ROOT, "dist/schemas");
const COMMAND_SCHEMA_ARTIFACT_DIR = resolve(REPO_ROOT, "dist/command-schemas");
const SCHEMA_REFERENCE_DIR = resolve(REPO_ROOT, "docs/reference/schemas");

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

const commandSpecFor = (commandClass: unknown): LandoCommandSpec | undefined =>
  (commandClass as { readonly landoSpec?: LandoCommandSpec }).landoSpec;

const commandSchemaArtifactFilename = (commandId: string): string => {
  const slug = commandId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0) {
    throw new Error(`Command id ${JSON.stringify(commandId)} does not produce a filename-safe slug.`);
  }
  return `${slug}.json`;
};

type CommandResultSchemaArtifact = {
  readonly commandId: string;
  readonly artifactPath: string;
  readonly schema: unknown;
};

const generateCommandResultSchemas = (): ReadonlyArray<CommandResultSchemaArtifact> => {
  const commands = compiledCommands as Record<string, unknown>;
  const artifacts = Object.keys(commands)
    .sort((left, right) => left.localeCompare(right))
    .map((commandId) => {
      const spec = commandSpecFor(commands[commandId]);
      if (spec?.resultSchema === undefined || spec.resultSchema === null) {
        throw new Error(`Command ${commandId} does not declare a resultSchema.`);
      }
      try {
        const filename = commandSchemaArtifactFilename(commandId);
        return {
          commandId,
          artifactPath: `dist/command-schemas/${filename}`,
          schema: stable(JSONSchema.make(spec.resultSchema)),
        };
      } catch (cause) {
        throw new Error(`Failed to generate command result JSON Schema for ${commandId}.`, { cause });
      }
    });
  const commandIdByPath = new Map<string, string>();
  for (const artifact of artifacts) {
    const existingCommandId = commandIdByPath.get(artifact.artifactPath);
    if (existingCommandId !== undefined) {
      throw new Error(
        `Command ids ${existingCommandId} and ${artifact.commandId} collide at ${artifact.artifactPath}.`,
      );
    }
    commandIdByPath.set(artifact.artifactPath, artifact.commandId);
  }
  return artifacts;
};

const renderJson = (value: unknown): string => `${JSON.stringify(stable(value), null, 2)}\n`;

const main = async (): Promise<void> => {
  assertPublicSchemaAnnotations();
  assertPublicSchemaContractCoverage(REPO_ROOT);

  const sdkSchemas = JSON_SCHEMA_NAMES.map((schemaName) => ({
    schemaName,
    jsonSchema: stable(generateJsonSchema(schemaName)),
  }));
  for (const { schemaName, jsonSchema } of sdkSchemas) {
    const invalidPaths = assertJsonSchemaDeprecationsValid(jsonSchema);
    if (invalidPaths.length > 0) {
      throw new Error(`${schemaName} emits invalid x-deprecation payloads at ${invalidPaths.join(", ")}`);
    }
  }
  const commandResultSchemas = generateCommandResultSchemas();
  const bundledPluginManifests = BUNDLED_PLUGIN_MODULES.map((plugin) => ({
    name: plugin.name,
    manifest: stable(Schema.encodeSync(PluginManifest)(plugin.manifest)),
  })).sort((left, right) => left.name.localeCompare(right.name));

  await Bun.write(BUNDLED_PLUGIN_MANIFESTS_OUTPUT, renderJson(bundledPluginManifests));
  await mkdir(SCHEMA_ARTIFACT_DIR, { recursive: true });
  await mkdir(COMMAND_SCHEMA_ARTIFACT_DIR, { recursive: true });
  await mkdir(SCHEMA_REFERENCE_DIR, { recursive: true });
  const metadataIndexPath = resolve(SCHEMA_ARTIFACT_DIR, "index.json");
  await Bun.write(metadataIndexPath, renderJson(publicSchemaMetadataIndex));
  const artifactPaths: string[] = [metadataIndexPath];
  for (const { schemaName, jsonSchema } of sdkSchemas) {
    const artifactPath = resolve(SCHEMA_ARTIFACT_DIR, schemaArtifactFilename(schemaName));
    artifactPaths.push(artifactPath);
    await Bun.write(artifactPath, renderJson(jsonSchema));
  }
  const schemaArtifactPaths = new Set(artifactPaths);
  for (const entry of await readdir(SCHEMA_ARTIFACT_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = resolve(SCHEMA_ARTIFACT_DIR, entry.name);
    if (!schemaArtifactPaths.has(path)) await rm(path);
  }

  const commandSchemaIndex = Object.fromEntries(
    commandResultSchemas.map(({ commandId, artifactPath }) => [commandId, artifactPath]),
  );
  const commandSchemaIndexPath = resolve(COMMAND_SCHEMA_ARTIFACT_DIR, "index.json");
  await Bun.write(commandSchemaIndexPath, renderJson(commandSchemaIndex));
  const commandSchemaArtifactPaths = new Set([commandSchemaIndexPath]);
  for (const artifact of commandResultSchemas) {
    const artifactPath = resolve(REPO_ROOT, artifact.artifactPath);
    commandSchemaArtifactPaths.add(artifactPath);
    await Bun.write(artifactPath, renderJson(artifact.schema));
  }
  for (const entry of await readdir(COMMAND_SCHEMA_ARTIFACT_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = resolve(COMMAND_SCHEMA_ARTIFACT_DIR, entry.name);
    if (!commandSchemaArtifactPaths.has(path)) await rm(path);
  }

  const referencePages = renderPublicSchemaReferencePages();
  const referencePaths = new Set(referencePages.map((page) => resolve(REPO_ROOT, page.docsPath)));
  for (const entry of await readdir(SCHEMA_REFERENCE_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".mdx")) continue;
    const path = resolve(SCHEMA_REFERENCE_DIR, entry.name);
    if (!referencePaths.has(path)) await rm(path);
  }
  for (const page of referencePages) {
    const referencePath = resolve(REPO_ROOT, page.docsPath);
    artifactPaths.push(referencePath);
    await Bun.write(referencePath, page.content);
  }

  // Format by directory roots so Windows command-line length stays bounded as
  // the public schema corpus grows (listing every artifact path can ENAMETOOLONG).
  await formatGeneratedPaths([
    BUNDLED_PLUGIN_MANIFESTS_OUTPUT,
    SCHEMA_ARTIFACT_DIR,
    COMMAND_SCHEMA_ARTIFACT_DIR,
    SCHEMA_REFERENCE_DIR,
  ]);
  await mirrorSchemaArtifacts({ repoRoot: REPO_ROOT });

  console.log(
    `[build-schema-snapshot] wrote ${sdkSchemas.length} SDK schemas and ${commandResultSchemas.length} command schemas`,
  );
};

await main();
