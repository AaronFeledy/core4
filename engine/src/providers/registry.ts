import { Effect, Layer, Option, Result, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import { GlobalConfigSources } from "../services/config.ts";

import {
  NoProviderInstalledError,
  PluginDescriptorMismatchError,
  ProviderCapabilityError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { AbsolutePath, type AppPlan, type PluginManifest, ProviderId } from "@lando/sdk/schema";
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

import { StartFailureLogRedactor } from "@lando/container-runtime/redact";
import { RedactionService, collectSecretEnvValues, createStandaloneRedactor } from "@lando/redaction/service";
import { type PrivateFileAccess, PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { bundledPluginModules } from "../composition.ts";
import { makePublishRender } from "../lifecycle/publish-render.ts";
import { makeLandoPluginContext } from "../plugins/context.ts";
import { makePluginCapabilityIndex } from "../plugins/module-set.ts";
import { collectAppPlanRedactionTokens } from "../services/app-plan-redaction.ts";
import {
  type AppliedStateProvider,
  observeProviderRuntime,
  resolveAppliedPlanEvidence,
  resolveTeardownEvidence,
} from "./applied-state-resolution.ts";
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

export const makeRuntimeProviderRegistry = (
  modules: ReadonlyArray<LandoPluginModule>,
  privateFileAccess: PrivateFileAccess,
) => {
  const capabilityIndex = makePluginCapabilityIndex(modules);

  return Layer.effect(
    RuntimeProviderRegistry,
    Effect.gen(function* () {
      const configService = yield* ConfigService;
      const captured = yield* Effect.serviceOption(GlobalConfigSources);
      const providerEnv = Option.isSome(captured) && captured.value.sources.env ? captured.value.env : {};
      const pluginRegistry = yield* PluginRegistry;
      const eventService = yield* Effect.serviceOption(EventService);
      const downloader = yield* Downloader;
      const logFileHelperAssets = yield* LogFileHelperAssets;
      const managedFileService = yield* ManagedFileService;
      const paths = yield* PathsService;
      const redaction = yield* Effect.serviceOption(RedactionService);
      const appPlanSanitizer = yield* AppPlanSanitizer;
      const stateStore = yield* StateStore;
      const httpClient = yield* HttpClient.HttpClient;

      const providerManifests = pluginRegistry.list.pipe(Effect.mapError(toProviderUnavailable));
      const providerIds = providerManifests.pipe(
        Effect.map((manifests) => manifests.flatMap(manifestProviderIds)),
      );

      const configuredProviderId = Effect.gen(function* () {
        const defaultProviderId = yield* configService.get("defaultProviderId");
        const envProviderId = readProviderEnvVar(providerEnv);
        return resolveProviderSelection({
          ...(envProviderId === undefined ? {} : { env: envProviderId }),
          ...(defaultProviderId === undefined || defaultProviderId === null
            ? {}
            : { config: defaultProviderId }),
          capabilityDefault: CAPABILITY_DEFAULT_PROVIDER_ID,
        }).providerId;
      });

      const contributionFor = Effect.fnUntraced(function* (providerId: ProviderId) {
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

        if (Result.isFailure(capabilityIndex)) return yield* Effect.die(capabilityIndex.failure);
        const contribution = capabilityIndex.success.runtimeProviders.get(providerId);
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

        const pluginStateRoot = yield* Schema.decodeUnknownEffect(AbsolutePath)(
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
          privateFileAccess,
          httpClient,
          ...(publishRender === undefined ? {} : { publishRender }),
        });
        return { contribution, context };
      });

      const makeProvider = (descriptor: Effect.Success<ReturnType<typeof contributionFor>>) => {
        const { contribution, context } = descriptor;
        const provider = contribution.make(context).pipe(
          Effect.provideService(PathsService, paths),
          Effect.provideService(Downloader, downloader),
          Effect.provideService(LogFileHelperAssets, logFileHelperAssets),
          Effect.provideService(AppPlanSanitizer, appPlanSanitizer),
          Effect.map(
            (runtime) =>
              ({
                ...runtime,
                apply: Effect.fnUntraced(function* (plan, options) {
                  const tokens = [
                    ...collectAppPlanRedactionTokens(plan),
                    ...Object.values(options?.serviceEnvironment ?? {}).flatMap(collectSecretEnvValues),
                  ];
                  const redactor =
                    redaction._tag === "Some"
                      ? yield* redaction.value
                          .registerValues(tokens)
                          .pipe(Effect.andThen(redaction.value.forProfile("secrets")))
                      : createStandaloneRedactor("secrets", { redactionTokens: tokens });
                  return yield* runtime
                    .apply(plan, options)
                    .pipe(Effect.provideService(StartFailureLogRedactor, redactor));
                }),
              }) satisfies typeof runtime,
          ),
          Effect.mapError(toProviderUnavailableFromCapability),
        );
        return eventService._tag === "Some"
          ? provider.pipe(Effect.provideService(EventService, eventService.value))
          : provider;
      };

      const providerFor = (providerId: ProviderId) =>
        contributionFor(providerId).pipe(Effect.flatMap(makeProvider));

      const activeProvider = Effect.flatMap(configuredProviderId, providerFor);

      const appliedStateProviders = Effect.gen(function* () {
        const ids = yield* providerIds;
        return yield* Effect.forEach(ids, (id) =>
          Effect.gen(function* () {
            const descriptor = yield* contributionFor(id);
            const { contribution, context } = descriptor;
            const resourceOwnership = contribution.resourceOwnership;
            const runtime = yield* Effect.cached(makeProvider(descriptor));
            return {
              id,
              ...(resourceOwnership === undefined
                ? {}
                : {
                    resourceOwnership: (root: AbsolutePath) => resourceOwnership(context, root),
                  }),
              canCleanupOwnedResources: runtime.pipe(
                Effect.map((provider) => provider.cleanupOwnedResources !== undefined),
              ),
              appliedPlans: contribution
                .appliedPlans(context)
                .pipe(Effect.provideService(PathsService, paths)),
              isAvailable: runtime.pipe(
                Effect.flatMap((provider) =>
                  provider.isAvailable.pipe(
                    Effect.flatMap((available) =>
                      available
                        ? Effect.map(provider.getStatus, (status) => status.running)
                        : Effect.succeed(false),
                    ),
                  ),
                ),
                Effect.catch(() => Effect.succeed(false)),
              ),
              list: (filter) => runtime.pipe(Effect.flatMap((provider) => provider.list(filter))),
              listVolumes: (filter) =>
                runtime.pipe(Effect.flatMap((provider) => provider.listVolumes(filter))),
            } satisfies AppliedStateProvider;
          }),
        );
      });

      const resolveAppliedPlan = Effect.fn("RuntimeProviderRegistry.resolveAppliedPlan")(
        (root: AbsolutePath) =>
          appliedStateProviders.pipe(
            Effect.flatMap((providers) => resolveAppliedPlanEvidence(root, providers)),
          ),
      );

      const resolveTeardown = Effect.fn("RuntimeProviderRegistry.resolveTeardownEvidence")(
        (root: AbsolutePath) =>
          appliedStateProviders.pipe(Effect.flatMap((providers) => resolveTeardownEvidence(root, providers))),
      );

      return RuntimeProviderRegistry.of({
        list: providerIds,
        capabilities: Effect.map(activeProvider, (provider) => provider.capabilities),
        select: Effect.fn("RuntimeProviderRegistry.select")(function* (target?: AppPlan | ProviderId) {
          return yield* target === undefined
            ? activeProvider
            : providerFor(typeof target === "string" ? target : target.provider);
        }),
        resourceOwnership: Effect.fn("RuntimeProviderRegistry.resourceOwnership")(
          (providerId: ProviderId, root: AbsolutePath) =>
            contributionFor(providerId).pipe(
              Effect.flatMap(
                ({ contribution, context }) =>
                  contribution.resourceOwnership?.(context, root) ?? Effect.succeed(undefined),
              ),
            ),
        ),
        resolveAppliedPlan,
        resolveTeardownEvidence: resolveTeardown,
        observeRuntime: appliedStateProviders.pipe(Effect.flatMap(observeProviderRuntime)),
      });
    }),
  );
};

export const makeRuntimeProviderRegistryWithPrivateFileAccess = (modules: ReadonlyArray<LandoPluginModule>) =>
  Layer.unwrap(
    Effect.map(PrivateFileAccessService, (privateFileAccess) =>
      makeRuntimeProviderRegistry(modules, privateFileAccess),
    ),
  );

export { RuntimeProviderRegistry };

export const layer = Layer.suspend(() =>
  makeRuntimeProviderRegistryWithPrivateFileAccess(bundledPluginModules()).pipe(
    Layer.provide(PrivateFileAccessService.layer),
  ),
);
