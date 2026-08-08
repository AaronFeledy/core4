import { Effect, Either, Layer, Schema } from "effect";

import {
  NoProviderInstalledError,
  PluginDescriptorMismatchError,
  ProviderCapabilityError,
  ProviderConfigError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { AbsolutePath, type PluginManifest, ProviderId } from "@lando/sdk/schema";
import {
  AppPlanSanitizer,
  ConfigService,
  Downloader,
  EventService,
  LogFileHelperAssets,
  ManagedFileService,
  PathsService,
  PluginRegistry,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";

import { bundledPluginModules } from "../composition.ts";
import { makePublishRender } from "../lifecycle/publish-render.ts";
import { makeLandoPluginContext } from "../plugins/context.ts";
import { makePluginCapabilityIndex } from "../plugins/module-set.ts";
import { RedactionService } from "../redaction/service.ts";
import {
  CAPABILITY_DEFAULT_PROVIDER_ID,
  readProviderEnvVar,
  resolveProviderSelection,
} from "./precedence.ts";

const manifestProviderIds = (manifest: PluginManifest): ReadonlyArray<ProviderId> =>
  (manifest.contributes?.providers ?? []).map((entry) =>
    ProviderId.make(typeof entry === "string" ? entry : entry.id),
  );

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
    providerId: "unknown",
    operation: "capabilities",
    message: "Unable to initialize runtime provider capabilities.",
    cause,
  });
};

export const makeRuntimeProviderRegistry = (modules: ReadonlyArray<LandoPluginModule>) => {
  const capabilityIndex = makePluginCapabilityIndex(modules);

  return Layer.effect(
    RuntimeProviderRegistry,
    Effect.gen(function* () {
      const configService = yield* ConfigService;
      const pluginRegistry = yield* PluginRegistry;
      const eventService = yield* Effect.serviceOption(EventService);
      const downloader = yield* Downloader;
      const logFileHelperAssets = yield* LogFileHelperAssets;
      const managedFileService = yield* ManagedFileService;
      const paths = yield* PathsService;
      const redaction = yield* Effect.serviceOption(RedactionService);
      const appPlanSanitizer = yield* AppPlanSanitizer;
      const stateStore = yield* StateStore;

      const providerManifests = pluginRegistry.list.pipe(Effect.mapError(toProviderUnavailable));
      const providerIds = providerManifests.pipe(
        Effect.map((manifests) => manifests.flatMap(manifestProviderIds)),
      );

      const configuredProviderId = Effect.gen(function* () {
        const defaultProviderId = yield* configService
          .get("defaultProviderId")
          .pipe(Effect.mapError(toProviderConfig));
        const envProviderId = readProviderEnvVar(process.env);
        return resolveProviderSelection({
          ...(envProviderId === undefined ? {} : { env: envProviderId }),
          ...(defaultProviderId === undefined || defaultProviderId === null
            ? {}
            : { config: defaultProviderId }),
          capabilityDefault: CAPABILITY_DEFAULT_PROVIDER_ID,
        }).providerId;
      });

      const providerFor = (providerId: ProviderId) =>
        Effect.gen(function* () {
          const manifests = yield* providerManifests;
          const providerIdText = String(providerId);
          const manifest = manifests.find((candidate) =>
            manifestProviderIds(candidate).some((installedId) => String(installedId) === providerIdText),
          );
          if (manifest === undefined) {
            return yield* Effect.fail(
              new NoProviderInstalledError({
                message: `Runtime provider ${providerIdText} is not installed.`,
              }),
            );
          }

          if (Either.isLeft(capabilityIndex)) return yield* Effect.die(capabilityIndex.left);
          const contribution = capabilityIndex.right.runtimeProviders.get(providerId);
          const module = modules.find(
            (candidate) => candidate.runtimeProviders?.get(providerId) === contribution,
          );
          if (contribution === undefined || module === undefined) {
            const manifestModule = modules.find((candidate) => candidate.name === manifest.name);
            return yield* Effect.die(
              new PluginDescriptorMismatchError({
                pluginName: manifest.name,
                kind: "providers",
                declared: [providerIdText],
                provided: [...(manifestModule?.runtimeProviders?.keys() ?? [])].map(String),
                message: `Plugin ${manifest.name} manifest and descriptor disagree for providers.`,
                remediation: `Align ${manifest.name}'s manifest providers ids with its descriptor providers ids.`,
              }),
            );
          }

          const pluginStateRoot = yield* Schema.decodeUnknown(AbsolutePath)(
            paths.pluginStateDir(module.name),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderUnavailableError({
                  providerId: providerIdText,
                  operation: "select",
                  message: `Unable to initialize runtime provider plugin ${module.name}.`,
                  remediation: `Verify the plugin state directory for ${module.name} is a valid absolute path.`,
                  cause,
                }),
            ),
          );
          const publishRender =
            eventService._tag === "Some" && redaction._tag === "Some"
              ? makePublishRender(eventService.value, redaction.value)
              : undefined;
          const context = makeLandoPluginContext({
            id: module.name,
            managedFileService,
            stateStore,
            pluginStateRoot,
            ...(publishRender === undefined ? {} : { publishRender }),
          });
          const provider = contribution
            .make(context)
            .pipe(
              Effect.provideService(PathsService, paths),
              Effect.provideService(Downloader, downloader),
              Effect.provideService(LogFileHelperAssets, logFileHelperAssets),
              Effect.provideService(AppPlanSanitizer, appPlanSanitizer),
              Effect.mapError(toProviderUnavailableFromCapability),
            );
          const providerWithEvents =
            eventService._tag === "Some"
              ? provider.pipe(Effect.provideService(EventService, eventService.value))
              : provider;
          return yield* providerWithEvents;
        });

      const activeProvider = Effect.flatMap(configuredProviderId, providerFor);

      return {
        list: providerIds,
        capabilities: Effect.map(activeProvider, (provider) => provider.capabilities),
        select: (plan) => (plan === undefined ? activeProvider : providerFor(plan.provider)),
      };
    }),
  );
};

export { RuntimeProviderRegistry };

export const RuntimeProviderRegistryLive = Layer.suspend(() =>
  makeRuntimeProviderRegistry(bundledPluginModules()),
);
