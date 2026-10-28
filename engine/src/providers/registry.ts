import { unreadableAppliedStateError } from "@lando/container-runtime/applied-state";
import { Context, Effect, Layer, Result, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import { GlobalConfigSources } from "../services/config.ts";

import {
  NoProviderInstalledError,
  PluginDescriptorMismatchError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { AbsolutePath, type AppPlan, type PluginManifest, ProviderId } from "@lando/sdk/schema";
import {
  AppPlanSanitizer,
  ConfigService,
  ContainerHelperAssets,
  Downloader,
  EventService,
  ManagedFileService,
  PathsService,
  PluginRegistry,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";

import { redactProviderError } from "@lando/redaction/provider-error";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { type PrivateFileAccess, PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { bundledPluginModules } from "../composition.ts";
import { makePublishRender } from "../lifecycle/publish-render.ts";
import { makeLandoPluginContext } from "../plugins/context.ts";
import { makePluginCapabilityIndex } from "../plugins/module-set.ts";
import { TeardownProvider } from "./app-placement.ts";
import {
  observeProviderRuntime,
  resolveAppliedPlanEvidence,
  resolveTeardownEvidence,
} from "./applied-state-resolution.ts";
import { hostProviderId } from "./host-provider.ts";
import { makeProviderFactory } from "./make-provider.ts";
import { makeAppliedStateProvider } from "./registry-evidence.ts";

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
    remediation:
      "Run lando plugin:list and repair the provider plugin manifest or import reported by the cause before retrying.",
  });

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
      const pluginRegistry = yield* PluginRegistry;
      const eventService = yield* Effect.serviceOption(EventService);
      const downloader = yield* Downloader;
      const containerHelperAssets = yield* ContainerHelperAssets;
      const managedFileService = yield* ManagedFileService;
      const paths = yield* PathsService;
      const redaction = yield* Effect.serviceOption(RedactionService);
      const redactorOptions = { sourceEnv: { ...process.env } };
      const errorRedactor =
        redaction._tag === "Some"
          ? yield* redaction.value.forProfile("secrets", redactorOptions)
          : createStandaloneRedactor("secrets", redactorOptions);
      const redactFailure = (error: ProviderUnavailableError) => redactProviderError(error, errorRedactor);
      const appPlanSanitizer = yield* AppPlanSanitizer;
      const stateStore = yield* StateStore;
      const httpClient = yield* HttpClient.HttpClient;

      const providerManifests = pluginRegistry.list.pipe(
        Effect.mapError((cause) => redactFailure(toProviderUnavailable(cause))),
      );
      const providerIds = providerManifests.pipe(
        Effect.map((manifests) => manifests.flatMap(manifestProviderIds)),
      );

      const configuredProviderId = hostProviderId.pipe(
        Effect.provideService(ConfigService, configService),
        Effect.provide(
          captured._tag === "Some" ? Context.make(GlobalConfigSources, captured.value) : Context.empty(),
        ),
      );

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
          Effect.mapError(redactFailure),
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
        const resourceOwnership = contribution.resourceOwnership;
        return {
          contribution: {
            ...contribution,
            appliedPlans: (ctx) => contribution.appliedPlans(ctx).pipe(Effect.mapError(redactFailure)),
            ...(resourceOwnership === undefined
              ? {}
              : {
                  resourceOwnership: (ctx, root) =>
                    resourceOwnership.call(contribution, ctx, root).pipe(Effect.mapError(redactFailure)),
                }),
          } satisfies typeof contribution,
          context,
        };
      });

      const makeProvider = makeProviderFactory({
        paths,
        downloader,
        containerHelperAssets,
        appPlanSanitizer,
        eventService,
        redaction,
        privateFileAccess,
        errorRedactor,
      });

      const providerFor = (providerId: ProviderId, desired?: AppPlan) =>
        contributionFor(providerId).pipe(Effect.flatMap((descriptor) => makeProvider(descriptor, desired)));

      const activeProvider = Effect.flatMap(configuredProviderId, providerFor);

      const appliedStateProviders = Effect.gen(function* () {
        const ids = yield* providerIds;
        const selected = yield* TeardownProvider;
        if (selected !== undefined) yield* contributionFor(selected);
        return yield* Effect.forEach(
          ids.filter((id) => selected === undefined || id === selected),
          (id) =>
            contributionFor(id).pipe(
              Effect.flatMap((descriptor) =>
                makeAppliedStateProvider(id, descriptor, { makeProvider, paths }),
              ),
            ),
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
        assertAppliedStateReadable: Effect.fn("RuntimeProviderRegistry.assertAppliedStateReadable")(
          function* (plan) {
            const { contribution, context } = yield* contributionFor(plan.provider);
            if (contribution.appliedStateInventory === undefined) return;
            const inventory = yield* contribution
              .appliedStateInventory(context)
              .pipe(Effect.provideService(PathsService, paths));
            const issue = inventory.unreadable.find(
              (entry) => entry.appId === undefined || entry.appId === plan.id,
            );
            if (issue !== undefined)
              return yield* Effect.fail(
                unreadableAppliedStateError({
                  providerId: plan.provider,
                  path: issue.path,
                  layout: issue.appId === undefined ? "record" : "per-app",
                }),
              );
          },
        ),
        list: providerIds,
        appliedPlansFor: Effect.fn("RuntimeProviderRegistry.appliedPlansFor")(function* (root) {
          const ids = yield* providerIds;
          const plans = yield* Effect.forEach(ids, (id) =>
            contributionFor(id).pipe(
              Effect.flatMap(({ contribution, context }) => contribution.appliedPlans(context)),
              Effect.provideService(PathsService, paths),
            ),
          );
          return plans.flat().filter((plan) => plan.identity?.appRoot === root);
        }),
        capabilities: Effect.map(activeProvider, (provider) => provider.capabilities),
        select: Effect.fn("RuntimeProviderRegistry.select")(function* (target?: AppPlan | ProviderId) {
          if (target === undefined) return yield* activeProvider;
          if (typeof target === "string") return yield* providerFor(target);
          return yield* providerFor(target.provider, target);
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
