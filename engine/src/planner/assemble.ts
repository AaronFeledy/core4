import { resolveNetworkTrustPlan } from "@lando/http-client/network-trust";
import {
  getVersionConstraintEntries,
  hasSkippedUnsatisfiedVersionConstraint,
} from "@lando/landofile/version-constraint";
import { LandofileValidationError, RouteProviderMismatchError, causeMessage } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type CurrentExecutableAppPlan,
  type LoadScopedLandofile,
  type NetworkingPlan,
  type ProviderCapabilities,
  type ServicePlan,
  landoNetworkingPlan,
} from "@lando/sdk/schema";
import { validationIssue } from "@lando/sdk/schema";
import { LANDO_HOST_EVENT_ENV } from "@lando/sdk/schema";
import {
  type AppPlannerError,
  CacheService,
  ConfigService,
  FileSystem,
  PathsService,
  PluginRegistry,
} from "@lando/sdk/services";
import { DateTime, Effect, Option, Predicate } from "effect";
import {
  deriveAppPlanCacheKey,
  readAppPlanSourceFingerprint,
  readCachedAppPlan,
  writeCachedAppPlan,
} from "../cache/app-plan.ts";
import { resolveUserCacheRoot } from "../cache/paths.ts";
import { routerEnabledFrom } from "../config/router-config.ts";
import { CertificateAuthorityResolver } from "../plugins/certificate-authority-resolver.ts";
import { FileSyncPolicy, fileSyncOrdinaryReason } from "../plugins/file-sync-policy.ts";
import { applyPreparedAppFeatures } from "../services/app-feature.ts";
import { validateServiceDependencies } from "../services/dependency-validation.ts";
import type { ApplicationConfig } from "../services/feature-preparation.ts";
import { loadGlobalSecurityCas, resolveSecurityFeature } from "../services/network-inject.ts";
import { resolveCertsFeature } from "../services/service-certs.ts";
import { GPG_AGENT_PLAN_EXTENSION_KEY, resolveGpgAgentIntent } from "../subsystems/gpg-agent/intent.ts";
import {
  HOST_PROXY_PLAN_EXTENSION_KEY,
  hostProxyExtensionForCapabilities,
} from "../subsystems/host-proxy/plan-extension.ts";
import { SSH_AGENT_FEATURE_ID } from "../subsystems/ssh/api.ts";
import {
  SSH_AGENT_PLAN_EXTENSION_KEY,
  resolveSshAgentIntent,
  sshAgentExtensionForIntent,
} from "../subsystems/ssh/intent.ts";
import { CORE_VERSION } from "../version.ts";
import * as AppDefaults from "./app-defaults.ts";
import { appFeatureError } from "./app-feature-error.ts";
import { planServiceDrafts } from "./authored.ts";
import {
  appFeatureCapabilityError,
  assertAuthoredNetworksSupported,
  assertComposeKnobsSupported,
  assertComposePreservedPathsSupported,
  assertComposeProjectFieldsSupported,
  assertComposeServiceFieldsSupported,
  providerSatisfiesCapability,
} from "./compose-capabilities.ts";
import { loadComposeConfigFiles } from "./config-files.ts";
import { validateConnectionValues } from "./connection-values.ts";
import { compileEffectiveEvents } from "./effective-events.ts";
import { attachEffectiveTooling } from "./effective-tooling.ts";
import { finalizeServices } from "./endpoints.ts";
import { environmentCacheInput } from "./environment-cache-input.ts";
import { resolveKnownEventSet } from "./event-set.ts";
import { attachCompiledInvocationPlan, compilePlanInvocationSites } from "./invocation-authority.ts";
import { normalizeNetworks } from "./networks.ts";
import { decodeAppPlan } from "./plan-decode.ts";
import { agentSocketCapabilityErrors, assertRouteNetworkingSupported } from "./resource-capabilities.ts";
import { attachScanPlans } from "./scanner-plan.ts";
import { plannerSeededFeatureIds } from "./seed-validation.ts";
import { resolveServiceConfigSources } from "./service-config-files.ts";
import { validateServiceProbes } from "./service-probes.ts";
import { type ResolvedService, resolvedServiceCacheInput } from "./service-types.ts";
import { authoredStorageScopes } from "./storage.ts";

export interface PlanAppInput {
  readonly landofile: LoadScopedLandofile;
  readonly providerCapabilities: ProviderCapabilities;
  readonly appRoot: string;
}

export const planApp = Effect.fn("AppPlanner.assemble")(function* (
  input: PlanAppInput,
): Effect.fn.Return<CurrentExecutableAppPlan, AppPlannerError, PluginRegistry | FileSyncPolicy> {
  const { landofile: authoredLandofile, providerCapabilities, appRoot: knownAppRoot } = input;
  const pluginRegistry = yield* PluginRegistry;
  const policyOwner = yield* FileSyncPolicy;
  const cacheService = Option.getOrUndefined(yield* Effect.serviceOption(CacheService));
  const configService = Option.getOrUndefined(yield* Effect.serviceOption(ConfigService));
  const fileSystem = Option.getOrUndefined(yield* Effect.serviceOption(FileSystem));
  const pathsService = Option.getOrUndefined(yield* Effect.serviceOption(PathsService));
  const certificateAuthorityResolver = Option.getOrUndefined(
    yield* Effect.serviceOption(CertificateAuthorityResolver),
  );
  const {
    landofile,
    appSlug,
    defaultDomain,
    services: seeds,
    effectiveTooling,
    connectionClients,
    disabledToolingSources,
    invocationSites,
    appRoot,
    appName,
    landofilePath,
    encodedMetadata,
    globalConfig,
    appDefaults,
    provider,
    hostProvider,
    manifests,
    topLevelEnvFiles,
    routes: resolvedRoutes,
    endpointProjection,
  } = yield* resolveKnownEventSet({
    pluginRegistry,
    configService,
    fileSystem,
    pathsService,
    landofile: authoredLandofile,
    capabilities: providerCapabilities,
    ...(knownAppRoot === undefined ? {} : { appRoot: knownAppRoot }),
  });
  const sshAgentIntent = resolveSshAgentIntent({ landofile, globalConfig });
  const gpgAgentIntent = resolveGpgAgentIntent({ landofile, globalConfig });
  const sshAgentExtension = sshAgentExtensionForIntent(sshAgentIntent);
  const appId = AppId.make(appSlug);
  const metadata: ServicePlan["metadata"] = {
    ...encodedMetadata,
    resolvedAt: DateTime.makeUnsafe(encodedMetadata.resolvedAt),
  };
  const routerEnabled = routerEnabledFrom(globalConfig?.router, landofile.router);
  const networkPlan = yield* Effect.try({
    try: () => resolveNetworkTrustPlan({ network: globalConfig?.network }, process.env),
    catch: (cause) =>
      new LandofileValidationError({
        message: `Global network trust configuration is invalid: ${causeMessage(cause)}`,
        remediation: "Correct the global network trust configuration and retry planning.",
        file: landofilePath,
        issues: [
          validationIssue(
            ["network"],
            `Global network trust configuration is invalid: ${causeMessage(cause)}`,
          ),
        ],
      }),
  });
  const globalCas = yield* loadGlobalSecurityCas(appRoot, networkPlan.caCertPaths);
  const fileSyncCandidates = policyOwner.candidates;
  const fileSyncPolicy = {
    platform: policyOwner.platform,
    bindMountPerformance:
      providerCapabilities.bindMountPerformance === "slow" ? ("slow" as const) : ("native" as const),
    ...(globalConfig?.defaultFileSyncEngine === undefined
      ? {}
      : { defaultEngine: globalConfig.defaultFileSyncEngine }),
  };
  const selectFileSyncEngine = yield* Effect.cached(
    policyOwner.select({
      capabilities: providerCapabilities,
      defaultEngine: globalConfig?.defaultFileSyncEngine,
    }),
  );
  if (
    globalConfig?.defaultFileSyncEngine !== undefined &&
    globalConfig.defaultFileSyncEngine !== "passthrough"
  )
    yield* selectFileSyncEngine;
  const cacheRoot = resolveUserCacheRoot();
  const sourceFingerprint = yield* readAppPlanSourceFingerprint(appRoot, landofile).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );
  const preparedApp = endpointProjection.preparedApp;
  const appFeatures = preparedApp.features;

  const composeConfigFileInputs = yield* loadComposeConfigFiles({
    appRoot,
    landofile,
    fileSystem,
    capabilities: providerCapabilities,
  });
  const resolvedServices: ResolvedService[] = [];
  for (const seed of seeds) {
    const {
      name,
      service: pinnedService,
      authored,
      serviceType,
      resolution,
      resolvedArtifactTag,
      projectFiles,
      envFileInputs,
      prepared,
      endpointContributions,
    } = seed;
    const service = seed.authoredService;
    const routes = resolvedRoutes.get(name);
    const configSourceInputs = yield* resolveServiceConfigSources({
      appRoot,
      serviceName: name,
      config: service.config,
    });
    const resolvedAuthored = authoredStorageScopes(appRoot, name, resolution.normalizedConfig);
    const authoredStores = new Map(authored.byStore);
    for (const [store, info] of resolvedAuthored.byStore) authoredStores.set(store, info);
    const storageAuthored = { ...authored, byStore: authoredStores };
    const logSources = seed.logSources;
    const seededFeatureIds = plannerSeededFeatureIds(resolution.base);
    const securityFeature =
      resolution.base === "lando"
        ? yield* resolveSecurityFeature({
            appName: appSlug,
            appRoot,
            serviceName: name,
            security: pinnedService.security,
            network: globalConfig?.network,
            networkPlan,
            globalCas,
            fileSystem,
            paths: pathsService,
          })
        : undefined;
    const certsFeature =
      resolution.base === "lando"
        ? yield* resolveCertsFeature({
            appName: appSlug,
            appRoot,
            serviceName: name,
            certs: resolution.normalizedConfig.certs ?? pinnedService.certs,
            hostnames: pinnedService.hostnames ?? [],
            routes: routes ?? [],
            defaultRouteHostname: routes === undefined ? `${name}.${appSlug}.${defaultDomain}` : undefined,
            resolveCertificateAuthority: certificateAuthorityResolver?.resolve,
            fileSystem,
          })
        : undefined;
    const plannerSeededFeatures = [
      securityFeature,
      certsFeature,
      { id: SSH_AGENT_FEATURE_ID, config: sshAgentExtension },
    ].filter((feature): feature is NonNullable<typeof feature> => feature !== undefined);
    const applicationConfigs = new Map<number, ApplicationConfig>();
    for (const feature of prepared.features) {
      if (!seededFeatureIds.has(feature.id)) continue;
      const replacement = plannerSeededFeatures.find((seeded) => seeded.id === feature.id);
      if (replacement !== undefined)
        applicationConfigs.set(feature.index, { _tag: "Materialized", config: replacement.config ?? {} });
    }
    for (const error of agentSocketCapabilityErrors(provider, providerCapabilities, {
      name,
      hostSsh:
        sshAgentIntent.mode === "host" &&
        prepared.features.some((feature) => feature.id === SSH_AGENT_FEATURE_ID),
      gpgForward: gpgAgentIntent.forward && resolution.base === "lando",
    }))
      yield* Effect.fail(error);
    resolvedServices.push({
      routes,
      name,
      service: pinnedService,
      authored: storageAuthored,
      serviceType,
      resolution,
      logSources,
      prepared,
      applicationConfigs,
      endpointContributions,
      resolvedArtifactTag,
      envFileInputs,
      projectFiles,
      configSourceInputs,
    });
  }
  const versionConstraints = getVersionConstraintEntries(landofile, landofilePath);
  const hostEvents =
    AppDefaults.isExcludedFromUserAppDefaults(appName, appRoot, pathsService) ||
    globalConfig?.hostEvents === undefined
      ? undefined
      : globalConfig.hostEvents;
  const hostEventCompileBase = {
    landofile,
    ...(hostEvents === undefined ? {} : { hostEvents }),
    skipHostEvents: process.env[LANDO_HOST_EVENT_ENV] === "1",
  };
  const executableSites = yield* compilePlanInvocationSites({
    sites: invocationSites,
    hostEvents,
    env: authoredLandofile.context.env,
  });
  const effectiveEventsFor = (services: Readonly<Record<string, { readonly primary?: boolean }>>) =>
    compileEffectiveEvents({ ...hostEventCompileBase, services, invocationSites: executableSites });
  const planServices = (services: Readonly<Record<string, unknown>>) =>
    Object.fromEntries(
      Object.entries(services).map(([name, service]) => [
        name,
        { primary: Predicate.isObject(service) && service.primary === true },
      ]),
    );
  const { sshAgent: _sshAgent, gpgAgent: _gpgAgent, ...cacheLandofile } = landofile;
  const cacheKey = deriveAppPlanCacheKey({
    hostProvider,
    appRoot,
    landofile: { ...cacheLandofile, provider },
    providerCapabilities,
    pluginManifests: manifests,
    appFeatureEnv: preparedApp.environment.bindings,
    config: AppDefaults.cacheInput(routerEnabled, globalConfig?.scanner, {
      ...appDefaults,
      defaultDomain,
      sshAgentMode: sshAgentIntent.mode,
      gpgAgentForward: gpgAgentIntent.forward,
    }),
    ...(sourceFingerprint === undefined ? {} : { sourceFingerprint }),
    versionConstraints,
    serviceInputs: {
      fileSyncPolicy: {
        ...fileSyncPolicy,
        bindMounts: providerCapabilities.bindMounts,
        bindMountPerformance: providerCapabilities.bindMountPerformance,
        persistentStorage: providerCapabilities.persistentStorage,
        candidates: fileSyncCandidates.map(({ id, capabilities, supports, defaultFor }) => ({
          id,
          supports,
          modes: capabilities.modes,
          exclusionPatterns: capabilities.exclusionPatterns,
          remoteAgentDeployment: capabilities.remoteAgentDeployment,
          defaultFor,
        })),
      },
      pendingSites: authoredLandofile.pendingSites,
      environment: environmentCacheInput(authoredLandofile),
      invocationSites: executableSites,
      landofile: landofile.services ?? {},
      composition: {
        topLevelEnvFileInputs: topLevelEnvFiles.inputs,
        composeConfigFileInputs,
        services: resolvedServices.map(resolvedServiceCacheInput),
        appFeatures: appFeatures.map((entry) => ({
          id: entry.id,
          ...(entry.pluginId === undefined ? {} : { pluginId: entry.pluginId }),
          priority: entry.definition.priority,
          ...(entry.definition.activatedBy === undefined
            ? {}
            : { activatedBy: entry.definition.activatedBy }),
          ...(entry.definition.selectors === undefined ? {} : { selectors: entry.definition.selectors }),
          ...(entry.definition.requires === undefined ? {} : { requires: entry.definition.requires }),
          ...(entry.config === undefined ? {} : { config: entry.config }),
        })),
      },
    },
  });
  if (cacheService !== undefined) {
    const cached = yield* readCachedAppPlan({
      cacheRoot,
      appName: appSlug,
      appRoot,
      key: cacheKey,
      fileSystem,
    }).pipe(Effect.catch(() => Effect.succeed(null)));
    if (cached !== null) {
      yield* validateServiceProbes(cached);
      if (cached.fileSync.length > 0) yield* selectFileSyncEngine;
      yield* assertAuthoredNetworksSupported(provider, providerCapabilities, cached.networking);
      yield* validateServiceDependencies(appRoot, cached.services);
      yield* assertComposeKnobsSupported(provider, providerCapabilities, cached.services);
      yield* assertComposeServiceFieldsSupported(provider, providerCapabilities, cached.services);
      yield* assertComposePreservedPathsSupported(provider, providerCapabilities, cached.services);
      yield* assertComposeProjectFieldsSupported(provider, providerCapabilities, cached.extensions);
      return attachCompiledInvocationPlan(
        attachEffectiveTooling(cached, effectiveTooling, connectionClients, disabledToolingSources),
        executableSites,
        effectiveEventsFor(planServices(cached.services)),
      );
    }
  }

  const plannedServiceDrafts = yield* planServiceDrafts({
    resolvedServices,
    appRoot,
  });
  const appFeatureResult = yield* applyPreparedAppFeatures(
    {
      appName,
      appRoot,
      services: plannedServiceDrafts.map((entry) => entry.draft),
    },
    preparedApp,
  ).pipe(Effect.mapError((error) => appFeatureError(appRoot, error)));
  const activatedFeatureIds = new Set(appFeatureResult.activatedFeatures.map((entry) => entry.id));
  for (const capability of appFeatureResult.requires.providerCapabilities) {
    if (providerSatisfiesCapability(providerCapabilities, capability)) continue;
    const offending = appFeatures.find(
      (entry) =>
        activatedFeatureIds.has(entry.id) &&
        (entry.definition.requires?.providerCapabilities ?? []).includes(capability),
    );
    yield* Effect.fail(appFeatureCapabilityError(provider, offending?.id ?? "appFeatures", capability));
  }

  const finalized = yield* finalizeServices({
    configs: landofile.configs,
    plannedServiceDrafts,
    appId,
    appRoot,
    appSlug,
    appName,
    defaultDomain,
    provider,
    providerCapabilities,
    metadata,
    selectFileSyncEngine,
    ordinaryFileSyncReason: fileSyncOrdinaryReason({
      capabilities: providerCapabilities,
      defaultEngine: globalConfig?.defaultFileSyncEngine,
    }),
    fileSystem,
  });
  if (routerEnabled && finalized.routes.length > 0 && provider !== hostProvider) {
    return yield* Effect.fail(
      new RouteProviderMismatchError({
        message: `App provider ${provider} differs from host router provider ${hostProvider}.`,
        providerId: provider,
        hostProviderId: hostProvider,
        remediation: `Run lando setup --provider=${provider} to move the global app and router there; remove provider: from the Landofile so the app follows the host provider; or set router.enabled: false and use published host ports.`,
      }),
    );
  }
  yield* assertRouteNetworkingSupported(
    provider,
    providerCapabilities,
    routerEnabled && finalized.routes.length > 0,
  );
  const serviceNames = Object.keys(finalized.services);
  const hasServices = serviceNames.length > 0;
  const perAppBridge = appId !== "global";
  const authoredNetworking = yield* normalizeNetworks({
    landofile,
    services: Object.fromEntries(
      resolvedServices
        .filter(({ name }) => serviceNames.includes(name))
        .map(({ name, service }) => [name, service]),
    ),
    appRoot,
    perAppBridge,
  });
  const networking: NetworkingPlan | undefined = hasServices
    ? landoNetworkingPlan({
        slug: appSlug,
        perAppBridge,
        serviceNames,
        sharedCrossAppNetwork: providerCapabilities.sharedCrossAppNetwork,
        serviceHostnames: finalized.serviceHostnames,
        ...authoredNetworking,
      })
    : undefined;
  const hostProxyExtension = hostProxyExtensionForCapabilities(providerCapabilities);
  const authoredProjectExtensions = Object.entries(landofile).filter(([key]) => key.startsWith("x-"));
  const composeProjectExtension = {
    ...(landofile.configs === undefined ? {} : { configs: landofile.configs }),
    ...(landofile.secrets === undefined ? {} : { secrets: landofile.secrets }),
    ...Object.fromEntries(authoredProjectExtensions),
  };
  const hasComposeProjectExtension = Object.keys(composeProjectExtension).length > 0;
  const requiredGlobalServices = [
    ...(finalized.routes.length > 0 && routerEnabled ? ["traefik"] : []),
    ...appFeatureResult.requires.globalServices,
  ];
  const plan = attachCompiledInvocationPlan(
    attachEffectiveTooling(
      yield* decodeAppPlan(appRoot, {
        id: appId,
        valueModel: 1,
        name: appName,
        slug: appSlug,
        root: AbsolutePath.make(appRoot),
        provider,
        router: { enabled: routerEnabled },
        services: finalized.services,
        routes: finalized.routes,
        ...(networking !== undefined ? { networking } : {}),
        stores: finalized.stores,
        fileSync: finalized.fileSync,
        fileSyncPolicy: finalized.fileSyncPolicy,
        metadata: encodedMetadata,
        extensions: {
          [SSH_AGENT_PLAN_EXTENSION_KEY]: sshAgentExtension,
          [GPG_AGENT_PLAN_EXTENSION_KEY]: { forward: gpgAgentIntent.forward },
          ...(hostProxyExtension === undefined
            ? {}
            : { [HOST_PROXY_PLAN_EXTENSION_KEY]: hostProxyExtension }),
          ...(hasComposeProjectExtension ? { compose: composeProjectExtension } : {}),
        },
        ...(requiredGlobalServices.length === 0
          ? {}
          : { requires: { globalServices: [...new Set(requiredGlobalServices)] } }),
      }).pipe(
        Effect.tap((decoded) => validateConnectionValues(appRoot, decoded.services)),
        Effect.map((decoded) => attachScanPlans(decoded, globalConfig?.scanner, resolvedServices)),
      ),
      effectiveTooling,
      connectionClients,
      disabledToolingSources,
    ),
    executableSites,
    effectiveEventsFor(planServices(finalized.services)),
  );
  yield* assertComposeKnobsSupported(provider, providerCapabilities, plan.services);
  yield* assertAuthoredNetworksSupported(provider, providerCapabilities, plan.networking);
  yield* validateServiceProbes(plan);
  yield* assertComposeServiceFieldsSupported(provider, providerCapabilities, plan.services);
  yield* assertComposePreservedPathsSupported(provider, providerCapabilities, plan.services);
  yield* assertComposeProjectFieldsSupported(provider, providerCapabilities, plan.extensions);
  if (
    cacheService !== undefined &&
    !hasSkippedUnsatisfiedVersionConstraint(versionConstraints, CORE_VERSION)
  ) {
    yield* writeCachedAppPlan({
      cacheRoot,
      appName: appSlug,
      appRoot,
      key: cacheKey,
      plan,
      versionConstraints,
      shadowHostChecks: finalized.shadowHostChecks,
      gitHostChecks: finalized.gitHostChecks,
    }).pipe(
      Effect.provideService(CacheService, cacheService),
      Effect.catch(() => Effect.void),
    );
  }
  return plan;
});
