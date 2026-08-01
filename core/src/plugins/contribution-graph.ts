import { Context, Effect, Either, Layer, Option, Scope } from "effect";

import { LandoRuntimeBootstrapError, PluginDescriptorMismatchError } from "@lando/sdk/errors";
import type { CertificateAuthorityContributionLayer, LandoPluginModule } from "@lando/sdk/plugins";
import type { CertificateAuthorityContribution, ResolvedPluginInput } from "@lando/sdk/schema";
import { CertificateAuthority, Logger, PathsService } from "@lando/sdk/services";

import { findAppRoot } from "../landofile/discovery.ts";
import { BUNDLED_PLUGIN_MODULES } from "./generated/bundled.ts";
import { makePluginCapabilityIndex } from "./module-set.ts";
import {
  type DiscoveredPlugin,
  discoverInstalledPlugins,
  systemPluginsFromModules,
} from "./plugin-discovery.ts";

export type PluginContributionSource = "bundled" | "system" | "user" | "app" | "explicit";

export interface LoadedPluginContribution extends DiscoveredPlugin {
  readonly source: PluginContributionSource;
  readonly entry?: LandoPluginModule;
}

export type CertificateAuthorityAcquisition =
  | { readonly kind: "service"; readonly service: Context.Tag.Service<typeof CertificateAuthority> }
  | { readonly kind: "layer"; readonly layer: CertificateAuthorityContributionLayer }
  | { readonly kind: "module"; readonly module: string };

export interface GraphCertificateAuthorityCandidate {
  readonly id: string;
  readonly pluginName: string;
  readonly source: string;
  readonly defaultFor?: CertificateAuthorityContribution["defaultFor"];
  readonly acquisition: CertificateAuthorityAcquisition;
}

export interface PluginContributionGraphShape {
  readonly plugins: ReadonlyArray<LoadedPluginContribution>;
  readonly certificateAuthorities: ReadonlyArray<GraphCertificateAuthorityCandidate>;
}

export class PluginContributionGraph extends Context.Tag("@lando/core/private/PluginContributionGraph")<
  PluginContributionGraph,
  PluginContributionGraphShape
>() {}

export interface PluginContributionGraphPolicy {
  readonly layers: ReadonlyArray<Layer.Layer<unknown, unknown, unknown>>;
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
  const merged = new Map<string, LoadedPluginContribution>();
  for (const source of sources) {
    for (const plugin of source) merged.set(plugin.manifest.name, plugin);
  }
  const disabled = new Set(disable);
  return [...merged.values()].filter((plugin) => !disabled.has(plugin.manifest.name));
};

const validateResolvedPlugin = (
  input: ResolvedPluginInput,
): Either.Either<LoadedPluginContribution, PluginDescriptorMismatchError> => {
  if (input.manifest.name !== input.entry.name || input.entry.manifest.name !== input.manifest.name) {
    return Either.left(
      new PluginDescriptorMismatchError({
        pluginName: input.entry.name,
        kind: "identity",
        declared: [input.manifest.name],
        provided: [input.entry.name, input.entry.manifest.name],
        message: "Pre-resolved plugin manifest and descriptor identities disagree.",
        remediation: "Use the same plugin name in the resolved manifest and LandoPluginModule descriptor.",
      }),
    );
  }
  return Either.map(makePluginCapabilityIndex([input.entry]), () => ({
    source: "explicit" as const,
    manifest: input.manifest,
    entry: input.entry,
    module: input.entry,
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
  new LandoRuntimeBootstrapError({ message, stage: "plugins", cause });

export const makePluginContributionGraphLive = (policy: PluginContributionGraphPolicy) =>
  Layer.scopedContext(
    Effect.gen(function* () {
      const paths = yield* PathsService;
      const loggerOption = yield* Effect.serviceOption(Logger);
      const logger = Option.getOrUndefined(loggerOption);
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
        ? systemPluginsFromModules(BUNDLED_PLUGIN_MODULES).map((plugin, index) => ({
            ...plugin,
            entry: BUNDLED_PLUGIN_MODULES[index],
          }))
        : [];
      const external = policy.externalImports;
      const system =
        external && policy.discovery.system
          ? yield* discoverInstalledPlugins("system", paths.systemPluginsDir, logger)
          : [];
      const user =
        external && policy.discovery.user
          ? yield* discoverInstalledPlugins("user", paths.pluginsDir, logger)
          : [];
      const appRoot =
        external && policy.discovery.app ? yield* Effect.promise(() => findAppRoot(policy.cwd)) : undefined;
      const app =
        appRoot === undefined
          ? []
          : yield* discoverInstalledPlugins("app", `${appRoot}/.lando/plugins`, logger);
      const explicit = yield* Effect.forEach(policy.manifests, (input) =>
        Either.match(validateResolvedPlugin(input), {
          onLeft: (cause) => Effect.fail(bootstrapFailure(cause.message, cause)),
          onRight: Effect.succeed,
        }),
      );
      const merged = mergeLoadedPluginSources(
        [bundled, system, user, app, explicit],
        policy.discovery.disable,
      );
      const graph: PluginContributionGraphShape = {
        plugins: merged,
        certificateAuthorities: [...rawCandidates, ...manifestCandidates(merged)],
      };
      return Context.add(rawContext, PluginContributionGraph, graph);
    }),
  );
