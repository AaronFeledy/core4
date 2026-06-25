import { lstat, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { Data, Effect } from "effect";

import {
  type ConfigError,
  type LandoCommandError,
  NotImplementedError,
  PluginManifestError,
} from "@lando/sdk/errors";
import { ConfigService } from "@lando/sdk/services";

import { invalidatePluginCommandCache } from "../../cache/command-index-writer.ts";
import { makeLandoPaths } from "../../config/paths.ts";
import {
  type InstalledPluginRegistry,
  readInstalledPluginRegistry,
  recordInstalledPlugin,
  removeInstalledPlugin,
} from "../../plugins/installed-registry.ts";
import { assertInsidePluginsRoot, readLinkedState, writeLinkedState } from "./plugin-link.ts";

export class PluginUnlinkNotLinkedError extends Data.TaggedError("PluginUnlinkNotLinkedError")<{
  readonly message: string;
  readonly commandId: "meta:plugin:unlink";
  readonly pluginName: string;
  readonly remediation: string;
}> {}

export interface PluginUnlinkOptions {
  readonly name: string;
  readonly userDataRoot?: string;
  readonly pluginsRoot?: string;
  readonly cacheRoot?: string;
}

export interface PluginUnlinkResult {
  readonly pluginName: string;
  readonly registryEntry: string;
  readonly action: "restored" | "removed";
  readonly restoredPath?: string;
}

const removeRegistrySymlink = async (path: string): Promise<void> => {
  const stats = await lstat(path).catch(() => undefined);
  if (stats?.isSymbolicLink() === true) await rm(path, { force: true });
};

const notLinkedError = (pluginName: string): PluginUnlinkNotLinkedError =>
  new PluginUnlinkNotLinkedError({
    message: `Plugin ${pluginName} is not linked; nothing to unlink.`,
    commandId: "meta:plugin:unlink",
    pluginName,
    remediation:
      "Only locally linked plugins can be unlinked. Use `lando plugin:remove <name>` to remove an installed plugin.",
  });

interface ResolvedUnlinkTarget {
  readonly registryEntry: string;
  readonly isLinkedSymlink: boolean;
  readonly registryMarksLinked: boolean;
  readonly lockedLinked: boolean;
  readonly registryEntryExists: boolean;
}

const resolveUnlinkTarget = async (
  pluginsRoot: string,
  pluginName: string,
  registry: InstalledPluginRegistry,
): Promise<ResolvedUnlinkTarget> => {
  const registryEntry = resolve(pluginsRoot, pluginName);
  assertInsidePluginsRoot(pluginsRoot, registryEntry, pluginName);
  const stats = await lstat(registryEntry).catch(() => undefined);
  const isLinkedSymlink = stats?.isSymbolicLink() === true;
  const lockedLinked = (await readLinkedState(pluginsRoot))[pluginName]?.source === "linked";
  return {
    registryEntry,
    isLinkedSymlink,
    registryMarksLinked: registry[pluginName]?.source === "linked",
    lockedLinked,
    registryEntryExists: stats !== undefined,
  };
};

export const pluginUnlink = (
  options: PluginUnlinkOptions,
): Effect.Effect<
  PluginUnlinkResult,
  ConfigError | LandoCommandError | NotImplementedError | PluginManifestError | PluginUnlinkNotLinkedError,
  ConfigService
> =>
  Effect.gen(function* () {
    let userDataRoot = options.userDataRoot;
    if (userDataRoot === undefined) {
      const configService = yield* ConfigService;
      userDataRoot = yield* configService.get("userDataRoot");
      if (userDataRoot === undefined) {
        return yield* Effect.fail(
          new NotImplementedError({
            message: "userDataRoot is not configured.",
            commandId: "meta:plugin:unlink",
            remediation: "Configure userDataRoot in <userConfRoot>/config.yml.",
          }),
        );
      }
    }
    const pluginsRoot = options.pluginsRoot ?? makeLandoPaths({ userDataRoot }).pluginsDir;
    const pluginName = options.name;

    const result = yield* Effect.tryPromise({
      try: async (): Promise<PluginUnlinkResult> => {
        const registry = await readInstalledPluginRegistry(pluginsRoot);
        const target = await resolveUnlinkTarget(pluginsRoot, pluginName, registry);

        // A real (non-symlink) directory at the registry path is an installed
        // plugin, not a link; refuse so unlink never deletes installed copies.
        if (target.registryEntryExists && !target.isLinkedSymlink) throw notLinkedError(pluginName);

        const isLinked = target.isLinkedSymlink || target.registryMarksLinked || target.lockedLinked;
        if (!isLinked) throw notLinkedError(pluginName);

        const lockedEntry = (await readLinkedState(pluginsRoot))[pluginName];
        const previousRegistry = lockedEntry?.previousRegistry;

        const dropLockedEntry = async (): Promise<void> => {
          const state = await readLinkedState(pluginsRoot);
          if (state[pluginName] === undefined) return;
          const next = { ...state };
          delete next[pluginName];
          await writeLinkedState(pluginsRoot, next);
        };

        if (previousRegistry !== undefined) {
          // Restore the prior registry copy atomically, then drop the link.
          await recordInstalledPlugin(pluginsRoot, previousRegistry);
          await removeRegistrySymlink(target.registryEntry);
          await dropLockedEntry();
          return {
            pluginName,
            registryEntry: target.registryEntry,
            action: "restored",
            restoredPath: previousRegistry.path,
          };
        }

        await removeRegistrySymlink(target.registryEntry);
        await removeInstalledPlugin(pluginsRoot, pluginName);
        await dropLockedEntry();
        return { pluginName, registryEntry: target.registryEntry, action: "removed" };
      },
      catch: (cause) =>
        cause instanceof PluginUnlinkNotLinkedError || cause instanceof PluginManifestError
          ? cause
          : new NotImplementedError({
              message: `Plugin unlink failed for ${pluginName}: ${String(cause)}`,
              commandId: "meta:plugin:unlink",
              remediation: "Check the linked plugin state under <userDataRoot>/plugins and retry.",
            }),
    });

    yield* invalidatePluginCommandCache({
      ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
    });
    return result;
  });

export const renderPluginUnlinkResult = (result: PluginUnlinkResult): string =>
  [
    `plugin-unlink: ${result.pluginName}`,
    `registry-entry: ${result.registryEntry}`,
    ...(result.restoredPath === undefined ? [] : [`restored-path: ${result.restoredPath}`]),
    `result: ${result.action}`,
  ].join("\n");
