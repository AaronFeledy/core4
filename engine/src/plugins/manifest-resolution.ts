import { findAppRoot } from "@lando/landofile/discovery";
import { Context, Effect } from "effect";
import { loadInstalledPluginManifest } from "./installed-plugin-loader.ts";
import { inspectInstalledPluginRegistry } from "./installed-registry.ts";
import {
  type ManifestDiagnostic,
  type PluginManifestEntry,
  type PluginManifestSource,
  selectPluginManifests,
} from "./manifest-selection.ts";

export interface ManifestResolutionInput {
  readonly bundled: readonly PluginManifestEntry[];
  readonly explicit?: readonly PluginManifestEntry[];
  readonly directories: readonly { readonly source: PluginManifestSource; readonly path: string }[];
  readonly cwd?: string;
  readonly disable?: readonly string[];
}

export const resolvePluginManifests = Effect.fnUntraced(function* (input: ManifestResolutionInput) {
  const directories = [...input.directories];
  if (input.cwd !== undefined) {
    const root = yield* findAppRoot(input.cwd);
    if (root !== undefined) directories.push({ source: "app", path: `${root}/.lando/plugins` });
  }
  const sources: PluginManifestEntry[][] = [[...input.bundled]];
  const diagnostics: ManifestDiagnostic[] = [];
  for (const directory of directories) {
    const inspection = yield* Effect.promise(() => inspectInstalledPluginRegistry(directory.path));
    for (const failure of inspection.failures)
      diagnostics.push({
        _tag: "PluginManifestError",
        message: `Invalid plugin registry metadata for ${failure.pluginId}: ${String(failure.cause)}`,
        remediation: "Repair the installed plugin registry metadata.",
        loser: { pluginName: failure.pluginId, source: directory.source },
      });
    const plugins: PluginManifestEntry[] = [];
    for (const entry of Object.values(inspection.registry)) {
      const result = yield* Effect.result(
        Effect.tryPromise({
          try: () => loadInstalledPluginManifest(entry.path),
          catch: (cause) => cause,
        }),
      );
      if (result._tag === "Success")
        plugins.push({ manifest: result.success, source: directory.source, path: entry.path });
      else
        diagnostics.push({
          _tag: "PluginManifestError",
          message: `Cannot read plugin ${entry.name}: ${String(result.failure)}`,
          remediation: "Repair the plugin manifest or reinstall the plugin.",
          loser: { pluginName: entry.name, source: directory.source },
        });
    }
    sources.push(plugins);
  }
  sources.push([...(input.explicit ?? [])]);
  const selected = selectPluginManifests(sources, input.disable);
  const globalPlugins = selectPluginManifests(
    sources.map((source) => source.filter((plugin) => plugin.source !== "app")),
    input.disable,
  ).plugins;
  return { ...selected, globalPlugins, diagnostics: [...diagnostics, ...selected.diagnostics].slice(0, 100) };
});

export type ResolvedPluginManifests = Effect.Success<ReturnType<typeof resolvePluginManifests>>;
export class PluginManifestResolution extends Context.Service<
  PluginManifestResolution,
  ResolvedPluginManifests
>()("@lando/engine/PluginManifestResolution") {}
