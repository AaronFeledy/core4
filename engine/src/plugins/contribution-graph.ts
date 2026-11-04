import { Context, Effect, Layer, Option, Result, Schema, Scope } from "effect";

import { LandoRuntimeBootstrapError, PluginDescriptorMismatchError } from "@lando/sdk/errors";
import type {
  CertificateAuthorityContributionLayer,
  ExecutableCommandLoader,
  LandoPluginModule,
} from "@lando/sdk/plugins";
import {
  type CertificateAuthorityContribution,
  PluginManifest,
  type ResolvedPluginInput,
} from "@lando/sdk/schema";
import { CertificateAuthority, PathsService } from "@lando/sdk/services";

import { bundledPluginModules } from "../composition.ts";
import { resolveGraphCommands } from "./command-contributions.ts";
import { loadInstalledPluginEntry } from "./installed-plugin-loader.ts";
export { pluginCommandCandidates } from "./command-contributions.ts";
import { PluginManifestResolution, resolvePluginManifests } from "./manifest-resolution.ts";
import { type ManifestDiagnostic, selectPluginManifests } from "./manifest-selection.ts";
import { type PluginCapabilityIndexError, makePluginCapabilityIndex } from "./module-set.ts";
import { type DiscoveredPlugin, systemPluginsFromModules } from "./plugin-discovery.ts";

export type PluginContributionSource = "bundled" | "system" | "user" | "app" | "explicit";

export interface LoadedPluginContribution extends DiscoveredPlugin {
  readonly source: PluginContributionSource;
  readonly entry?: LandoPluginModule;
}

export type CertificateAuthorityAcquisition =
  | { readonly kind: "service"; readonly service: Context.Service.Shape<typeof CertificateAuthority> }
  | { readonly kind: "layer"; readonly layer: CertificateAuthorityContributionLayer }
  | { readonly kind: "module"; readonly module: string };

export interface GraphCertificateAuthorityCandidate {
  readonly id: string;
  readonly pluginName: string;
  readonly source: string;
  readonly defaultFor?: CertificateAuthorityContribution["defaultFor"];
  readonly acquisition: CertificateAuthorityAcquisition;
}

export interface GraphCommandCandidate {
  readonly id: string;
  readonly pluginName: string;
  readonly source: PluginContributionSource;
  readonly load: ExecutableCommandLoader;
  readonly descriptor: import("@lando/sdk/schema").CommandContribution;
}

export interface PluginContributionGraphShape {
  readonly diagnostics?: readonly ManifestDiagnostic[];
  readonly plugins: ReadonlyArray<LoadedPluginContribution>;
  readonly globalPlugins: ReadonlyArray<LoadedPluginContribution>;
  readonly certificateAuthorities: ReadonlyArray<GraphCertificateAuthorityCandidate>;
  readonly commands: ReadonlyArray<GraphCommandCandidate>;
  readonly hostContext: Context.Context<never>;
}

export class PluginContributionGraph extends Context.Service<
  PluginContributionGraph,
  PluginContributionGraphShape
>()("@lando/engine/PluginContributionGraph") {
  static readonly layer = <R>(
    policy: PluginContributionGraphPolicy<R>,
    modules: ReadonlyArray<LandoPluginModule> = bundledPluginModules(),
  ) =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const paths = yield* PathsService;
        const resolutionOption = yield* Effect.serviceOption(PluginManifestResolution);
        const scope = yield* Scope.Scope;
        let rawContext = Context.empty();
        const rawCandidates: GraphCertificateAuthorityCandidate[] = [];
        for (const [index, layer] of policy.layers.entries()) {
          const context = yield* Layer.buildWithScope(layer, scope).pipe(
            Effect.mapError((cause) => bootstrapFailure(`Failed to build plugins.layers[${index}].`, cause)),
          );
          const authority = Context.getOption(context, CertificateAuthority);
          if (Option.isSome(authority)) {
            rawCandidates.push({
              id: authority.value.id,
              pluginName: `plugins.layers[${index}]`,
              source: `plugins.layers[${index}]`,
              acquisition: { kind: "service", service: authority.value },
            });
          }
          rawContext = Context.merge(rawContext, Context.omit(CertificateAuthority)(context));
        }

        const bundled = policy.discovery.bundled
          ? systemPluginsFromModules(modules).map((plugin, index) => ({
              ...plugin,
              ...(modules[index] === undefined ? {} : { entry: modules[index] }),
            }))
          : [];
        const validationDiagnostics: ManifestDiagnostic[] = [];
        const explicit = policy.manifests.map(
          (input): LoadedPluginContribution =>
            Result.match(validateResolvedPlugin(input), {
              onFailure: (cause) => {
                validationDiagnostics.push({
                  _tag: cause._tag,
                  message: cause.message,
                  remediation: cause.remediation,
                  loser: { pluginName: String(input.manifest.name), source: "explicit" },
                });
                return { manifest: input.manifest, source: "explicit" };
              },
              onSuccess: (plugin) => plugin,
            }),
        );
        const suppliedResolution = Option.isSome(resolutionOption)
          ? resolutionOption
          : Context.getOption(rawContext, PluginManifestResolution);
        const selected = Option.isSome(suppliedResolution)
          ? suppliedResolution.value
          : yield* resolvePluginManifests({
              bundled,
              explicit,
              directories: policy.externalImports
                ? [
                    ...(policy.discovery.system
                      ? [{ source: "system" as const, path: paths.systemPluginsDir }]
                      : []),
                    ...(policy.discovery.user ? [{ source: "user" as const, path: paths.pluginsDir }] : []),
                  ]
                : [],
              ...(policy.externalImports && policy.discovery.app ? { cwd: policy.cwd } : {}),
              disable: policy.discovery.disable,
            });
        const diagnostics = [...validationDiagnostics, ...selected.diagnostics].slice(0, 100);
        const loadedPlugins = yield* Effect.forEach(
          [
            ...selected.plugins,
            ...selected.globalPlugins.filter((plugin) => !selected.plugins.includes(plugin)),
          ],
          (plugin) => {
            const loaded = [...explicit, ...bundled].find(
              (entry) => entry.source === plugin.source && entry.manifest.name === plugin.manifest.name,
            );
            if (loaded !== undefined) return Effect.succeed({ ...loaded, manifest: plugin.manifest });
            return Effect.tryPromise({
              try: async (): Promise<LoadedPluginContribution> => {
                const module = await loadInstalledPluginEntry(plugin.path ?? "", plugin.manifest);
                return { ...plugin, ...(module === undefined ? {} : { module }) };
              },
              catch: (cause) => cause,
            }).pipe(
              Effect.catch((cause) => {
                diagnostics.push({
                  _tag: "PluginLoadError",
                  message: String(cause),
                  remediation: "Repair the plugin entry.",
                  loser: { pluginName: String(plugin.manifest.name), source: plugin.source },
                });
                return Effect.succeed(plugin);
              }),
            );
          },
        );
        const merged = loadedPlugins.filter((plugin) =>
          selected.plugins.some((entry) => entry.manifest === plugin.manifest),
        );
        const globalPlugins = loadedPlugins.filter((plugin) =>
          selected.globalPlugins.some((entry) => entry.manifest === plugin.manifest),
        );
        const resolvedCommands = resolveGraphCommands(merged, selected.commands);
        const graph: PluginContributionGraphShape = {
          plugins: merged,
          globalPlugins,
          certificateAuthorities: [...rawCandidates, ...manifestCandidates(merged)],
          commands: resolvedCommands.commands,
          diagnostics: [...diagnostics, ...resolvedCommands.diagnostics].slice(0, 100),
          hostContext: rawContext,
        };
        return PluginContributionGraph.of(graph);
      }),
    ).pipe(
      Layer.flatMap((context) =>
        Layer.succeedContext(
          Context.merge(Context.get(context, PluginContributionGraph).hostContext, context),
        ),
      ),
    );
}

export interface PluginContributionGraphPolicy<R = unknown> {
  readonly layers: ReadonlyArray<Layer.Layer<unknown, unknown, R>>;
  readonly manifests: ReadonlyArray<ResolvedPluginInput>;
  readonly discovery: {
    readonly bundled: boolean;
    readonly system: boolean;
    readonly user: boolean;
    readonly app: boolean;
    readonly disable: ReadonlyArray<string>;
  };
  readonly externalImports: boolean;
  readonly cwd: string;
}

export const mergeLoadedPluginSources = (
  sources: ReadonlyArray<ReadonlyArray<LoadedPluginContribution>>,
  disable: ReadonlyArray<string>,
): ReadonlyArray<LoadedPluginContribution> => {
  return selectPluginManifests(sources, disable).plugins;
};

const validateResolvedPlugin = (
  input: ResolvedPluginInput,
): Result.Result<LoadedPluginContribution, PluginCapabilityIndexError> => {
  const isModule = (entry: unknown): entry is LandoPluginModule =>
    typeof entry === "object" &&
    entry !== null &&
    "name" in entry &&
    typeof entry.name === "string" &&
    "manifest" in entry &&
    Schema.is(PluginManifest)(entry.manifest) &&
    (!("certificateAuthorities" in entry) || entry.certificateAuthorities instanceof Map);
  const entry = input.entry;
  if (!isModule(entry)) {
    return Result.fail(
      new PluginDescriptorMismatchError({
        pluginName: input.manifest.name,
        kind: "identity",
        declared: [input.manifest.name],
        provided: [],
        message: "Expected an already-loaded LandoPluginModule object.",
        remediation: "Provide a loaded plugin descriptor alongside its resolved manifest.",
      }),
    );
  }
  if (input.manifest.name !== entry.name || entry.manifest.name !== input.manifest.name) {
    return Result.fail(
      new PluginDescriptorMismatchError({
        pluginName: entry.name,
        kind: "identity",
        declared: [input.manifest.name],
        provided: [entry.name, entry.manifest.name],
        message: "Pre-resolved plugin manifest and descriptor identities disagree.",
        remediation: "Use the same plugin name in the resolved manifest and LandoPluginModule descriptor.",
      }),
    );
  }
  return Result.map(makePluginCapabilityIndex([entry]), () => ({
    source: "explicit" as const,
    manifest: input.manifest,
    entry,
    module: entry,
  }));
};

const manifestCandidates = (
  plugins: ReadonlyArray<LoadedPluginContribution>,
): ReadonlyArray<GraphCertificateAuthorityCandidate> =>
  plugins.flatMap((plugin) =>
    (plugin.manifest.contributes?.certificateAuthorities ?? []).map((contribution) => {
      const layer = plugin.entry?.certificateAuthorities?.get(contribution.id);
      const acquisition: CertificateAuthorityAcquisition =
        layer === undefined ? { kind: "module", module: contribution.module } : { kind: "layer", layer };
      return {
        id: contribution.id,
        pluginName: plugin.manifest.name,
        source: plugin.source,
        ...(contribution.defaultFor === undefined ? {} : { defaultFor: contribution.defaultFor }),
        acquisition,
      };
    }),
  );

const bootstrapFailure = (message: string, cause: unknown) =>
  new LandoRuntimeBootstrapError({
    message,
    stage: "plugins",
    cause,
    remediation:
      "Repair bundled or user plugin discovery (invalid manifests, missing modules) and re-run the command.",
  });

export const withPluginLayerOverrides = <A, E, R>(
  runtimeLayer: Layer.Layer<A | PluginContributionGraph, E, R>,
): Layer.Layer<A | PluginContributionGraph, E, R> => {
  const hostOverrides = Layer.effectContext(
    Effect.map(PluginContributionGraph, (graph) => graph.hostContext),
  ).pipe(Layer.provide(runtimeLayer));
  return Layer.merge(runtimeLayer, hostOverrides);
};
