import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { findAppRoot } from "@lando/landofile/discovery";
import { canonicalJson } from "@lando/sdk/digest";
import { Context, Effect } from "effect";
import { loadInstalledPluginManifest } from "./installed-plugin-loader.ts";
import { inspectInstalledPluginRegistry } from "./installed-registry.ts";
import {
  type ManifestDiagnostic,
  type PluginManifestEntry,
  type PluginManifestSource,
  selectPluginManifests,
} from "./manifest-selection.ts";
import { packageRootPath } from "./plugin-module-path.ts";

export interface ManifestResolutionInput {
  readonly bundled: readonly PluginManifestEntry[];
  readonly explicit?: readonly PluginManifestEntry[];
  readonly directories: readonly { readonly source: PluginManifestSource; readonly path: string }[];
  readonly cwd?: string;
  readonly disable?: readonly string[];
}

export const resolvePluginManifests = Effect.fnUntraced(function* (input: ManifestResolutionInput) {
  const directories = [...input.directories];
  const appRoot = input.cwd === undefined ? undefined : yield* findAppRoot(input.cwd);
  if (appRoot !== undefined) directories.push({ source: "app", path: join(appRoot, ".lando", "plugins") });
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
          try: async () => {
            // Pin the package used to read the manifest and later import its implementation.
            const path = await realpath(packageRootPath(entry.path));
            const manifest = await loadInstalledPluginManifest(path);
            return { manifest, source: directory.source, path };
          },
          catch: (cause) => cause,
        }),
      );
      if (result._tag === "Success") plugins.push(result.success);
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
  return {
    ...selected,
    globalPlugins,
    diagnostics: [...diagnostics, ...selected.diagnostics].slice(0, 100),
  };
});

export type ResolvedPluginManifests = Effect.Success<ReturnType<typeof resolvePluginManifests>>;

/** Selection order matters: when different plugins provide the same command, the first one wins. */
export const samePluginSelection = (
  loaded: ResolvedPluginManifests["plugins"],
  candidate: ResolvedPluginManifests["plugins"],
): boolean =>
  loaded.length === candidate.length &&
  loaded.every(({ source, path, manifest }, index) => {
    const other = candidate[index];
    return (
      other !== undefined &&
      source === other.source &&
      path === other.path &&
      canonicalJson(manifest) === canonicalJson(other.manifest)
    );
  });

export class PluginManifestResolution extends Context.Service<
  PluginManifestResolution,
  ResolvedPluginManifests
>()("@lando/engine/PluginManifestResolution") {}
