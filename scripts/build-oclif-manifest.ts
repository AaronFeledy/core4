#!/usr/bin/env bun
/**
 * Regenerate `core/oclif.manifest.json` from the OCLIF command tree.
 */
import { resolve } from "node:path";

import { type Command, Config } from "@oclif/core";

import { writeFormattedOutput } from "./_codegen-output.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CORE_ROOT = resolve(REPO_ROOT, "core");
const OUTPUT = resolve(CORE_ROOT, "oclif.manifest.json");

const main = async (): Promise<void> => {
  const config = await Config.load({ root: CORE_ROOT, ignoreManifest: true });
  const rootPlugin = config.plugins.get(config.pjson.name);

  if (!rootPlugin) {
    throw new Error(`Unable to load OCLIF root plugin ${config.pjson.name}`);
  }

  const commands: Record<string, Command.Cached> = {};

  for (const command of rootPlugin.commands) {
    const { load: _load, ...cached } = command;
    commands[command.id] = cached;
  }

  const manifest = { commands, version: config.version };

  await writeFormattedOutput(OUTPUT, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[build-oclif-manifest] wrote ${OUTPUT} (${Object.keys(manifest.commands).length} commands)`);
};

await main();
