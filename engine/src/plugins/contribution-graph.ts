import { Context, Effect, Either, Layer, Option, Scope } from "effect";

import { LandoRuntimeBootstrapError, PluginDescriptorMismatchError } from "@lando/sdk/errors";
import type {
  CertificateAuthorityContributionLayer,
  ExecutableCommandLoader,
  LandoPluginModule,
} from "@lando/sdk/plugins";
import type { CertificateAuthorityContribution, ResolvedPluginInput } from "@lando/sdk/schema";
import { CertificateAuthority, Logger, PathsService } from "@lando/sdk/services";

import { findAppRoot } from "@lando/landofile/discovery";
import { bundledPluginModules } from "../composition.ts";
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

export interface GraphCommandCandidate {
  readonly id: string;
  readonly pluginName: string;
  readonly source: PluginContributionSource;
  readonly load: ExecutableCommandLoader;
}

export interface PluginContributionGraphShape {
  readonly plugins: ReadonlyArray<LoadedPluginContribution>;
  readonly certificateAuthorities: ReadonlyArray<GraphCertificateAuthorityCandidate>;
  readonly commands: ReadonlyArray<GraphCommandCandidate>;
  readonly hostContext: Context.Context<never>;
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

const commandLoaders = (plugin: LoadedPluginContribution): ReadonlyMap<string, ExecutableCommandLoader> => {
  const direct = plugin.entry?.commands ?? plugin.module?.commands;
  if (direct instanceof Map) return direct;
  const nested = plugin.module !== undefined && "plugin" in plugin.module ? plugin.module.plugin : undefined;
  if (
    typeof nested === "object" &&
    nested !== null &&
    "commands" in nested &&
    nested.commands instanceof Map
  ) {
    return nested.commands;
  }
  return new Map();
};

export const pluginCommandCandidates = (
  plugins: ReadonlyArray<LoadedPluginContribution>,
): Either.Either<ReadonlyArray<GraphCommandCandidate>, PluginDescriptorMismatchError> => {
  const candidates: GraphCommandCandidate[] = [];
  const owners = new Map<string, string>();
  for (const plugin of plugins) {
    const declared = (plugin.manifest.contributes?.commands ?? []).map((value) =>
      typeof value === "string" ? value : value.id,
    );
    const loaders = commandLoaders(plugin);
    const provided = [...loaders.keys()];
    const declaredIds = new Set(declared);
    if (provided.some((id) => !declaredIds.has(id))) {
      return Either.left(
        new PluginDescriptorMismatchError({
          pluginName: String(plugin.manifest.name),
          kind: "commands",
          declared,
          provided,
          message: `Plugin ${String(plugin.manifest.name)} manifest and descriptor disagree for commands.`,
          remediation: `Align ${String(plugin.manifest.name)}'s manifest command ids with its executable command loaders.`,
        }),
      );
    }
    for (const [id, load] of loaders) {
      const owner = owners.get(id);
      if (owner !== undefined) {
        return Either.left(
          new PluginDescriptorMismatchError({
            pluginName: String(plugin.manifest.name),
            kind: "commands",
            declared: [id],
            provided: [id],
            message: `Plugin ${String(plugin.manifest.name)} duplicates command id ${id} from ${owner}.`,
            remediation: `Rename or remove the duplicate command ${id}.`,
          }),
        );
      }
      owners.set(id, String(plugin.manifest.name));
      candidates.push({ id, pluginName: String(plugin.manifest.name), source: plugin.source, load });
    }
  }
  return Either.right(candidates);
};

const bootstrapFailure = (message: string, cause: unknown) =>
  new LandoRuntimeBootstrapError({ message, stage: "plugins", cause });

export const makePluginContributionGraphLive = (
  policy: PluginContributionGraphPolicy,
  modules: ReadonlyArray<LandoPluginModule> = bundledPluginModules(),
) =>
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
        ? systemPluginsFromModules(modules).map((plugin, index) => ({
            ...plugin,
            entry: modules[index],
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
      const commands = yield* Either.match(pluginCommandCandidates(merged), {
        onLeft: (cause) => Effect.fail(bootstrapFailure(cause.message, cause)),
        onRight: Effect.succeed,
      });
      const graph: PluginContributionGraphShape = {
        plugins: merged,
        certificateAuthorities: [...rawCandidates, ...manifestCandidates(merged)],
        commands,
        hostContext: rawContext,
      };
      return Context.add(rawContext, PluginContributionGraph, graph);
    }),
  );

export const withPluginLayerOverrides = <A, E, R>(
  runtimeLayer: Layer.Layer<A | PluginContributionGraph, E, R>,
): Layer.Layer<A | PluginContributionGraph, E, R> => {
  const hostOverrides = Layer.scopedContext(
    Effect.map(PluginContributionGraph, (graph) => graph.hostContext),
  ).pipe(Layer.provide(runtimeLayer));
  return Layer.merge(runtimeLayer, hostOverrides);
};
