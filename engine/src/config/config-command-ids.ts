import { makeLandoPathsFromRoots, normalizeHostPlatform, resolveLandoRootsFromSources } from "@lando/paths";
import {
  type ConfigLayer,
  type ConfigSourceInputs,
  configRecord,
  mergeGlobalConfigSources,
} from "@lando/paths/config-sources";
import type { PluginManifest } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { loadInstalledPluginManifest } from "../plugins/installed-plugin-loader.ts";
import { readInstalledPluginRegistry } from "../plugins/installed-registry.ts";

export interface ConfigDecoderInputs extends ConfigSourceInputs {
  readonly commandIds?: readonly string[];
  readonly commandPlugins?: {
    readonly manifests: readonly PluginManifest[];
    readonly explicit?: readonly PluginManifest[];
    readonly system?: boolean;
    readonly user: boolean;
    readonly disable: readonly string[];
  };
}

export const configCommandIds = Effect.fnUntraced(function* (
  stack: readonly ConfigLayer[],
  inputs: ConfigDecoderInputs,
) {
  if (inputs.commandIds === undefined) return undefined;
  if (inputs.commandPlugins?.disable.includes("@lando/notify-lando")) return undefined;
  const ids = new Set(inputs.commandIds);
  const plugins = inputs.commandPlugins;
  const manifests = new Map((plugins?.manifests ?? []).map((manifest) => [manifest.name, manifest]));
  const notify = mergeGlobalConfigSources(stack).tree.notify;
  if (
    (plugins?.user === true || plugins?.system === true) &&
    configRecord(notify) &&
    notify.enabled !== false &&
    Array.isArray(notify.commands) &&
    notify.commands.some((id) => typeof id === "string" && !ids.has(id))
  ) {
    const paths = makeLandoPathsFromRoots(
      resolveLandoRootsFromSources(stack),
      normalizeHostPlatform({ env: inputs.env }),
    );
    for (const directory of [
      ...(plugins.system ? [paths.systemPluginsDir] : []),
      ...(plugins.user ? [paths.pluginsDir] : []),
    ]) {
      const registry = yield* Effect.promise(() => readInstalledPluginRegistry(directory));
      for (const entry of Object.values(registry)) {
        const loaded = yield* Effect.tryPromise({
          try: () => loadInstalledPluginManifest(entry.path),
          catch: (cause) => cause,
        }).pipe(Effect.result);
        if (Result.isSuccess(loaded)) manifests.set(loaded.success.name, loaded.success);
      }
    }
  }
  for (const manifest of plugins?.explicit ?? []) manifests.set(manifest.name, manifest);
  for (const manifest of manifests.values()) {
    if (plugins?.disable.includes(manifest.name)) continue;
    for (const command of manifest.contributes?.commands ?? [])
      ids.add(typeof command === "string" ? command : command.id);
  }
  return ids;
});
