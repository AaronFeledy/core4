/**
 * `RuntimeProviderRegistry` Live Layer.
 *
 * MVP selection is config-driven: `ConfigService.defaultProviderId` selects a
 * provider id from the provider contributions exposed by `PluginRegistry`.
 */
import { type Context, Effect, Layer, Stream } from "effect";

import { NoProviderInstalledError, ProviderConfigError, ProviderUnavailableError } from "@lando/sdk/errors";
import { type ProviderCapabilities, ProviderId } from "@lando/sdk/schema";
import {
  ConfigService,
  PluginRegistry,
  RuntimeProvider,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/sdk/services";

const landoCapabilities: ProviderCapabilities = {
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceHealth: "lando",
  hostReachability: "emulated",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: true,
  hostPortPublish: "proxy",
  routeProvider: false,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "portable",
  providerExtensions: [],
};

const dockerCapabilities: ProviderCapabilities = {
  ...landoCapabilities,
  hostReachability: "native",
  hostPortPublish: "native",
  tlsCertificates: "none",
  composeSpec: "native",
};

const makeUnavailable = (providerId: string, operation: string) =>
  new ProviderUnavailableError({
    providerId,
    operation,
    message: `Runtime provider ${providerId} does not implement ${operation} yet.`,
  });

const makeProvider = (
  id: "lando" | "docker",
  displayName: string,
  capabilities: ProviderCapabilities,
): RuntimeProviderShape => ({
  id,
  displayName,
  version: "0.0.0",
  platform: "linux",
  capabilities,
  isAvailable: Effect.succeed(true),
  setup: () => Effect.void,
  getStatus: Effect.succeed({ running: true, message: "ready" }),
  getVersions: Effect.succeed({ provider: "0.0.0" }),
  buildArtifact: () => Effect.fail(makeUnavailable(id, "buildArtifact")),
  pullArtifact: () => Effect.fail(makeUnavailable(id, "pullArtifact")),
  removeArtifact: () => Effect.void,
  apply: () => Effect.succeed({ changed: false }),
  start: () => Effect.void,
  stop: () => Effect.void,
  restart: () => Effect.void,
  destroy: () => Effect.void,
  exec: () => Effect.fail(makeUnavailable(id, "exec")),
  execStream: () => Stream.fail(makeUnavailable(id, "execStream")),
  run: () => Effect.fail(makeUnavailable(id, "run")),
  logs: () => Stream.empty,
  inspect: () => Effect.fail(makeUnavailable(id, "inspect")),
  list: () => Effect.succeed([]),
});

const landoProvider = makeProvider("lando", "Lando Runtime Provider", landoCapabilities);
const dockerProvider = makeProvider("docker", "Docker Runtime Provider", dockerCapabilities);

const providers: Readonly<Record<string, RuntimeProviderShape>> = {
  lando: landoProvider,
  docker: dockerProvider,
};

const toProviderUnavailable = (cause: unknown) =>
  new ProviderUnavailableError({
    providerId: "unknown",
    operation: "list",
    message: "Unable to list runtime provider plugins.",
    cause,
  });

const toProviderConfig = (cause: unknown) =>
  new ProviderConfigError({
    providerId: "unknown",
    operation: "select",
    message: "Unable to read the default runtime provider configuration.",
    cause,
  });

const makeRuntimeProviderRegistry = (
  configService: Context.Tag.Service<typeof ConfigService>,
  pluginRegistry: Context.Tag.Service<typeof PluginRegistry>,
): Context.Tag.Service<typeof RuntimeProviderRegistry> => {
  const providerIds = Effect.mapError(
    Effect.map(pluginRegistry.list, (manifests) =>
      manifests.flatMap((manifest) => manifest.contributes?.providers ?? []).map((id) => ProviderId.make(id)),
    ),
    toProviderUnavailable,
  );

  const activeProvider = Effect.gen(function* () {
    const defaultProviderId = yield* Effect.mapError(
      configService.get("defaultProviderId"),
      toProviderConfig,
    );

    if (defaultProviderId === undefined || defaultProviderId === null) {
      return yield* Effect.fail(
        new NoProviderInstalledError({ message: "No default runtime provider is configured." }),
      );
    }

    const installedProviderIds = yield* providerIds;
    const defaultProviderIdText = String(defaultProviderId);
    const installed = installedProviderIds.some((providerId) => String(providerId) === defaultProviderIdText);
    const provider = providers[defaultProviderIdText];

    if (!installed || provider === undefined) {
      return yield* Effect.fail(
        new NoProviderInstalledError({
          message: `Runtime provider ${defaultProviderIdText} is not installed.`,
        }),
      );
    }

    return provider;
  });

  return {
    list: providerIds,
    capabilities: Effect.map(activeProvider, (provider) => provider.capabilities),
    select: () => activeProvider,
  };
};

export { RuntimeProviderRegistry };

export const RuntimeProviderRegistryLive = Layer.effect(
  RuntimeProviderRegistry,
  Effect.map(Effect.all([ConfigService, PluginRegistry]), ([configService, pluginRegistry]) =>
    makeRuntimeProviderRegistry(configService, pluginRegistry),
  ),
);

export const LandoRuntimeProviderLive = Layer.succeed(RuntimeProvider, landoProvider);
export const DockerRuntimeProviderLive = Layer.succeed(RuntimeProvider, dockerProvider);
