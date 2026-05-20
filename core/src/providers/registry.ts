/**
 * `RuntimeProviderRegistry` Live Layer.
 *
 * Provider selection defaults to `ConfigService.defaultProviderId`, but a
 * planned app keeps using its encoded `AppPlan.provider` so fresh lifecycle
 * commands do not drift when the global default provider changes.
 */
import { type Context, Effect, Layer, Stream } from "effect";

import { makeRuntimeProvider as makeLandoRuntimeProvider } from "@lando/provider-lando";
import {
  NoProviderInstalledError,
  ProviderCapabilityError,
  ProviderConfigError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import { type ProviderCapabilities, ProviderId } from "@lando/sdk/schema";
import {
  ConfigService,
  EventService,
  PluginRegistry,
  RuntimeProvider,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/sdk/services";

type EventPublisher = Pick<Context.Tag.Service<typeof EventService>, "publish">;

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

const dockerProvider = makeProvider("docker", "Docker Runtime Provider", dockerCapabilities);

const providers: Readonly<Record<string, RuntimeProviderShape>> = {
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

const toProviderUnavailableFromCapability = (
  cause: ProviderCapabilityError | ProviderUnavailableError,
): ProviderUnavailableError => {
  if (cause instanceof ProviderUnavailableError) return cause;
  if (cause instanceof ProviderCapabilityError) {
    return new ProviderUnavailableError({
      providerId: cause.providerId,
      operation: cause.operation,
      message: cause.message,
      ...(cause.details === undefined ? {} : { details: cause.details }),
      ...(cause.remediation === undefined ? {} : { remediation: cause.remediation }),
      cause,
    });
  }
  return new ProviderUnavailableError({
    providerId: "lando",
    operation: "capabilities",
    message: "Unable to initialize provider-lando capabilities.",
    cause,
  });
};

const makeRuntimeProviderRegistry = (
  configService: Context.Tag.Service<typeof ConfigService>,
  pluginRegistry: Context.Tag.Service<typeof PluginRegistry>,
  eventService: EventPublisher | undefined,
): Context.Tag.Service<typeof RuntimeProviderRegistry> => {
  const providerIds = Effect.mapError(
    Effect.map(pluginRegistry.list, (manifests) =>
      manifests.flatMap((manifest) => manifest.contributes?.providers ?? []).map((id) => ProviderId.make(id)),
    ),
    toProviderUnavailable,
  );

  const configuredProviderId = Effect.gen(function* () {
    const defaultProviderId = yield* Effect.mapError(
      configService.get("defaultProviderId"),
      toProviderConfig,
    );

    if (defaultProviderId === undefined || defaultProviderId === null) {
      return yield* Effect.fail(
        new NoProviderInstalledError({ message: "No default runtime provider is configured." }),
      );
    }

    return defaultProviderId;
  });

  const providerFor = (providerId: ProviderId) =>
    Effect.gen(function* () {
      const installedProviderIds = yield* providerIds;
      const providerIdText = String(providerId);
      const installed = installedProviderIds.some((installedId) => String(installedId) === providerIdText);
      const userDataRoot = yield* Effect.mapError(configService.get("userDataRoot"), toProviderConfig);
      const provider =
        providerIdText === "lando"
          ? yield* makeLandoRuntimeProvider({
              ...(userDataRoot === undefined ? {} : { stateDir: `${userDataRoot}/providers` }),
              ...(eventService === undefined ? {} : { eventService }),
            }).pipe(Effect.mapError(toProviderUnavailableFromCapability))
          : providers[providerIdText];

      if (!installed || provider === undefined) {
        return yield* Effect.fail(
          new NoProviderInstalledError({
            message: `Runtime provider ${providerIdText} is not installed.`,
          }),
        );
      }

      return provider;
    });

  const activeProvider = Effect.flatMap(configuredProviderId, providerFor);

  return {
    list: providerIds,
    capabilities: Effect.map(activeProvider, (provider) => provider.capabilities),
    select: (plan) => (plan === undefined ? activeProvider : providerFor(plan.provider)),
  };
};

export { RuntimeProviderRegistry };

export const RuntimeProviderRegistryLive = Layer.effect(
  RuntimeProviderRegistry,
  Effect.gen(function* () {
    const configService = yield* ConfigService;
    const pluginRegistry = yield* PluginRegistry;
    const eventService = yield* Effect.serviceOption(EventService);
    return makeRuntimeProviderRegistry(
      configService,
      pluginRegistry,
      eventService._tag === "Some" ? eventService.value : undefined,
    );
  }),
);

export const LandoRuntimeProviderLive = Layer.effect(
  RuntimeProvider,
  makeLandoRuntimeProvider().pipe(Effect.mapError(toProviderUnavailableFromCapability)),
);
export const DockerRuntimeProviderLive = Layer.succeed(RuntimeProvider, dockerProvider);
