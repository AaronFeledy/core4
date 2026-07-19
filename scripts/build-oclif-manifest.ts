#!/usr/bin/env bun
import { rm } from "node:fs/promises";
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
const COMMAND_IDS_OUTPUT = resolve(CORE_ROOT, "src/cli/generated/command-ids.ts");

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

const renderCommandIdsModule = (commandIds: ReadonlyArray<string>): string => `/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via \`bun run scripts/build-oclif-manifest.ts\`.
 */
export const BUILT_IN_COMMAND_IDS = ${JSON.stringify(commandIds, null, 2)} as const;
`;

const cacheDefaultValue = async (flag: Interfaces.OptionFlag<unknown>): Promise<unknown> => {
  if (typeof flag.defaultHelp === "function") {
    try {
      return await flag.defaultHelp({ flags: {}, options: flag });
    } catch (_error) {
      return undefined;
    }
  }

  if (typeof flag.default === "function") {
    try {
      return await flag.default({ flags: {}, options: flag });
    } catch (_error) {
      return undefined;
    }
  }

  return flag.default;
};

const cacheLoadedFlag = async (
  name: string,
  flag: Interfaces.BooleanFlag<unknown> | Interfaces.OptionFlag<unknown>,
): Promise<Command.Flag.Cached> => {
  const common = {
    aliases: flag.aliases,
    char: flag.char,
    charAliases: flag.charAliases,
    combinable: flag.combinable,
    dependsOn: flag.dependsOn,
    deprecateAliases: flag.deprecateAliases,
    deprecated: flag.deprecated,
    description: flag.description,
    env: flag.env,
    exclusive: flag.exclusive,
    helpGroup: flag.helpGroup,
    helpLabel: flag.helpLabel,
    hidden: flag.hidden,
    name,
    noCacheDefault: flag.noCacheDefault,
    relationships: flag.relationships,
    required: flag.required,
    summary: flag.summary,
  };

  if (flag.type === "boolean") {
    return {
      ...common,
      allowNo: flag.allowNo,
      type: flag.type,
    };
  }

  return {
    ...common,
    default: await cacheDefaultValue(flag),
    delimiter: flag.delimiter,
    hasDynamicHelp: typeof flag.defaultHelp === "function",
    helpValue: flag.helpValue,
    multiple: flag.multiple,
    options: flag.options,
    type: flag.type,
  };
};

const cacheLoadedFlags = async (
  flags: Interfaces.FlagInput | undefined,
): Promise<Record<string, Command.Flag.Cached>> =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(flags ?? {}).map(async ([name, flag]) => [name, await cacheLoadedFlag(name, flag)]),
    ),
  );

const main = async (): Promise<void> => {
  await rm(JSON_OUTPUT, { force: true });
  const config = await Config.load({ root: CORE_ROOT, ignoreManifest: true });
  const rootPlugin = config.plugins.get(config.pjson.name);

  if (!rootPlugin) {
    throw new Error(`Unable to load OCLIF root plugin ${config.pjson.name}`);
  }

  const commands: Record<string, Command.Cached> = {};

  for (const command of rootPlugin.commands) {
    const { load: _load, ...cached } = command;
    const loaded = await command.load();
    const baseFlags = (loaded as { readonly baseFlags?: Interfaces.FlagInput }).baseFlags;
    const flags = await cacheLoadedFlags({ ...(baseFlags ?? {}), ...(loaded.flags ?? {}) });
    commands[command.id] = {
      ...cached,
      flags,
      hasDynamicHelp: Object.values(flags).some((flag) => flag.hasDynamicHelp === true),
      hidden: cached.hidden ?? false,
    };
  }

  const manifest = { commands, version: config.version } satisfies Interfaces.Manifest;

  await writeFormattedOutput(JSON_OUTPUT, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFormattedOutput(TS_OUTPUT, renderCompiledManifestModule(manifest));
  await writeFormattedOutput(COMMAND_IDS_OUTPUT, renderCommandIdsModule(Object.keys(commands)));
  console.log(
    `[build-oclif-manifest] wrote ${JSON_OUTPUT} + ${TS_OUTPUT} + ${COMMAND_IDS_OUTPUT} (${Object.keys(manifest.commands).length} commands)`,
  );
};

await main();
