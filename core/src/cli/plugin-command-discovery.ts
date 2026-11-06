import {
  PluginContributionGraph,
  type PluginContributionGraphShape,
} from "@lando/engine/plugins/contribution-graph";
import {
  PluginManifestResolution,
  type ResolvedPluginManifests,
  resolvePluginManifests,
} from "@lando/engine/plugins/manifest-resolution";
import { cliRuntimeOptions } from "@lando/engine/runtime/cli-options";
import { discoveryCwd } from "@lando/landofile/operation-discovery";
import { makeLandoPathsFromRoots, normalizeHostPlatform, resolveLandoRootsFromSources } from "@lando/paths";
import { readGlobalConfigSources } from "@lando/paths/config-sources";
import { PluginDescriptorMismatchError } from "@lando/sdk/errors";
import { PluginManifest } from "@lando/sdk/schema";
import { Effect, Layer, Schema } from "effect";
import { makeLandoRuntime } from "../runtime/layer";
import { BUNDLED_PLUGIN_MANIFESTS } from "./generated/bundled-command-descriptors";

const acquirePluginCommandGraph = Effect.fnUntraced(function* (resolution: ResolvedPluginManifests) {
  yield* Effect.promise(() => import("../runtime/bundled-plugins"));
  const cwd = yield* discoveryCwd();
  return yield* Effect.scoped(
    PluginContributionGraph.pipe(
      Effect.provide(
        makeLandoRuntime(
          cliRuntimeOptions({
            bootstrap: "plugins",
            cwd,
            plugins: { policy: "discovery", layers: [Layer.succeed(PluginManifestResolution, resolution)] },
          }),
        ),
      ),
    ),
  );
});

export const acquirePluginCommandMetadata = Effect.fnUntraced(
  function* (): Effect.fn.Return<PluginContributionGraphShape> {
    const sources = readGlobalConfigSources({ env: process.env, sources: { user: true, env: true } });
    const paths = makeLandoPathsFromRoots(
      resolveLandoRootsFromSources(sources),
      normalizeHostPlatform({ env: process.env }),
    );
    const cwd = yield* discoveryCwd();
    const selected = yield* resolvePluginManifests({
      bundled: BUNDLED_PLUGIN_MANIFESTS.map((manifest) => ({
        manifest: Schema.decodeUnknownSync(PluginManifest)(manifest),
        source: "bundled" as const,
      })),
      directories: [
        { source: "system", path: paths.systemPluginsDir },
        { source: "user", path: paths.pluginsDir },
      ],
      cwd,
    });
    let graph: Promise<PluginContributionGraphShape> | undefined;
    return {
      plugins: selected.plugins,
      globalPlugins: selected.globalPlugins,
      certificateAuthorities: [],
      hostContext: yield* Effect.context<never>(),
      diagnostics: selected.diagnostics,
      commands: selected.commands.map((command) => ({
        ...command,
        load: async () => {
          graph ??= Effect.runPromise(acquirePluginCommandGraph(selected));
          const candidate = (await graph).commands.find(
            (entry) =>
              entry.id === command.id &&
              entry.pluginName === command.pluginName &&
              entry.source === command.source,
          );
          if (candidate === undefined)
            throw new PluginDescriptorMismatchError({
              pluginName: command.pluginName,
              kind: "commands",
              declared: [command.id],
              provided: [],
              message: `Plugin ${command.pluginName} has no loader for ${command.id}.`,
              remediation: "Provide a loader for the selected manifest command.",
            });
          return candidate.load();
        },
      })),
    };
  },
);
