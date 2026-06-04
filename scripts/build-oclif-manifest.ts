#!/usr/bin/env bun
/**
 * Regenerate OCLIF manifest assets from the OCLIF command tree.
 */
import { resolve } from "node:path";

import { type Command, Config, type Interfaces } from "@oclif/core";

import { writeFormattedOutput } from "./_codegen-output.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CORE_ROOT = resolve(REPO_ROOT, "core");
const JSON_OUTPUT = resolve(CORE_ROOT, "oclif.manifest.json");
const TS_OUTPUT = resolve(CORE_ROOT, "src/cli/oclif/compiled-manifest.ts");

const renderCompiledManifestModule = (manifest: Interfaces.Manifest): string => `/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via \`bun run scripts/build-oclif-manifest.ts\`.
 *
 * The compiled binary embeds the OCLIF manifest through this static module so
 * command metadata is available without reading \`oclif.manifest.json\` from
 * disk at runtime.
 */
import type { Interfaces } from "@oclif/core";

export const COMPILED_OCLIF_MANIFEST = ${JSON.stringify(manifest, null, 2)} satisfies Interfaces.Manifest;
`;

const main = async (): Promise<void> => {
  const config = await Config.load({ root: CORE_ROOT, ignoreManifest: true });
  const rootPlugin = config.plugins.get(config.pjson.name);

  if (!rootPlugin) {
    throw new Error(`Unable to load OCLIF root plugin ${config.pjson.name}`);
  }

  const commands: Record<string, Command.Cached> = {};

  for (const command of rootPlugin.commands) {
    const { load: _load, ...cached } = command;
    commands[command.id] = { ...cached, hidden: cached.hidden ?? false };
  }

  const manifest = { commands, version: config.version } satisfies Interfaces.Manifest;

  await writeFormattedOutput(JSON_OUTPUT, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFormattedOutput(TS_OUTPUT, renderCompiledManifestModule(manifest));
  console.log(
    `[build-oclif-manifest] wrote ${JSON_OUTPUT} + ${TS_OUTPUT} (${Object.keys(manifest.commands).length} commands)`,
  );
};

await main();
