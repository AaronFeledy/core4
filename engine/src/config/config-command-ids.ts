import { makeLandoPathsFromRoots, normalizeHostPlatform, resolveLandoRootsFromSources } from "@lando/paths";
import {
  type ConfigLayer,
  type ConfigSourceInputs,
  configRecord,
  mergeGlobalConfigSources,
} from "@lando/paths/config-sources";
import type { PluginManifest } from "@lando/sdk/schema";
import { Effect } from "effect";
import { resolvePluginManifests } from "../plugins/manifest-resolution.ts";

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
  const directories: { source: "system" | "user"; path: string }[] = [];
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
    if (plugins.system) directories.push({ source: "system", path: paths.systemPluginsDir });
    if (plugins.user) directories.push({ source: "user", path: paths.pluginsDir });
  }
  const selected = yield* resolvePluginManifests({
    bundled: (plugins?.manifests ?? []).map((manifest) => ({ manifest, source: "bundled" as const })),
    explicit: (plugins?.explicit ?? []).map((manifest) => ({ manifest, source: "explicit" as const })),
    directories,
    disable: plugins?.disable ?? [],
  });
  for (const command of selected.commands) ids.add(command.id);
  return ids;
});
