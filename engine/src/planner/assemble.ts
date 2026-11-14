import { resolveNetworkTrustPlan } from "@lando/http-client/network-trust";
import { landofileValidationError } from "@lando/landofile/validation";
import {
  getVersionConstraintEntries,
  hasSkippedUnsatisfiedVersionConstraint,
} from "@lando/landofile/version-constraint";
import { makeLandoPaths } from "@lando/paths";
import { mapFailures } from "@lando/sdk/command-result";
import { LandofileValidationError, causeMessage } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppIdentity,
  type AppRef,
  type CurrentExecutableAppPlan,
  LANDO_HOST_EVENT_ENV,
  type LoadScopedLandofile,
  type NetworkingPlan,
  type ProviderCapabilities,
  type ServicePlan,
  landoNetworkingPlan,
  normalizeAppSlug,
  validationIssue,
} from "@lando/sdk/schema";
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
import {
  type CertificateAuthorityCandidateDefinition,
  manifestCertificateAuthorityCandidates,
  selectContributedCertificateAuthority,
} from "../plugins/certificate-authority-resolver.ts";
import { PluginContributionGraph, loadedPluginImplementations } from "../plugins/contribution-graph.ts";
import { FileSyncPolicy, fileSyncOrdinaryReason } from "../plugins/file-sync-policy.ts";
import { applyPreparedAppFeatures } from "../services/app-feature.ts";
import { validateServiceDependencies } from "../services/dependency-validation.ts";
import type { ApplicationConfig } from "../services/feature-preparation.ts";
import { loadGlobalSecurityCas, resolveSecurityFeature } from "../services/network-inject.ts";
import { certificateLeafLocation, resolveCertsFeature } from "../services/service-certs.ts";
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
import { withCommittedLiteralDigests } from "./authored-literals.ts";
import { materializeClonedServiceDrafts, networkServicesWithClones } from "./cloned-services.ts";
import {
  appFeatureCapabilityError,
  assertAuthoredNetworksSupported,
  assertComposeFieldsSupported,
  assertComposeKnobsSupported,
  providerAlternatives,
  providerSatisfiesCapability,
} from "./compose-capabilities.ts";
import { loadComposeConfigFiles } from "./config-files.ts";
import { validateConnectionValues } from "./connection-values.ts";
import { compileEffectiveEvents } from "./effective-events.ts";
import { attachEffectiveTooling } from "./effective-tooling.ts";
import { finalizeServices } from "./endpoints.ts";
import { environmentCacheInput } from "./environment-cache-input.ts";
import { type ResolvedLandofile, resolveKnownEventSet } from "./event-set.ts";
import { fileSyncCacheInput } from "./file-sync-cache-input.ts";
import { hostEventsShellIssues } from "./host-shell-issues.ts";
import { attachCompiledInvocationPlan, compilePlanInvocationSites } from "./invocation-authority.ts";
import { normalizeNetworks } from "./networks.ts";
import { assertRoutesCertificateCoverable, decodeAppPlan } from "./plan-decode.ts";
import {
  agentSocketCapabilityErrors,
  assertRouteNetworkingSupported,
  assertServiceInitSupported,
} from "./resource-capabilities.ts";
import { resolvePlanRouter } from "./router-plan.ts";
import { attachScanPlans } from "./scanner-plan.ts";
import { plannerSeededFeatureIds } from "./seed-validation.ts";
import { hasServiceArtifacts } from "./service-artifact.ts";
import { resolveServiceConfigSources } from "./service-config-files.ts";
import { validateServiceProbes } from "./service-probes.ts";
import { type ResolvedService, resolvedServiceCacheInput } from "./service-types.ts";
import { authoredStorageScopes } from "./storage.ts";

export interface PlanAppInput {
  readonly identity?: AppIdentity;
  readonly dataName?: string;
  readonly kind?: AppRef["kind"];
  readonly landofile: LoadScopedLandofile;
  readonly providerCapabilities: ProviderCapabilities;
  readonly appRoot: string;
  readonly mode?: "validate";
  readonly resolution?: ResolvedLandofile;
}

export const planApp = Effect.fn("AppPlanner.assemble")(function* (
  input: PlanAppInput,
): Effect.fn.Return<CurrentExecutableAppPlan, AppPlannerError, PluginRegistry | FileSyncPolicy> {
  const { landofile: authoredLandofile, providerCapabilities, appRoot: knownAppRoot } = input;
  const pluginRegistry = yield* PluginRegistry;
  const contributionGraph = Option.getOrUndefined(yield* Effect.serviceOption(PluginContributionGraph));
  const plugins = loadedPluginImplementations(contributionGraph);
  const policyOwner = yield* FileSyncPolicy;
  const cacheService = Option.getOrUndefined(yield* Effect.serviceOption(CacheService));
  const configService = Option.getOrUndefined(yield* Effect.serviceOption(ConfigService));
  const fileSystem = Option.getOrUndefined(yield* Effect.serviceOption(FileSystem));
  const pathsService = Option.getOrUndefined(yield* Effect.serviceOption(PathsService));
  const {
    landofile,
    appSlug,
    defaultDomain,
    services: seeds,
    effectiveTooling,
    connectionClients,
    toolingProvenance,
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
  } = yield* resolveKnownEventSet(
    {
      pluginRegistry,
      configService,
      fileSystem,
      pathsService,
      landofile: authoredLandofile,
      ...(input.dataName === undefined ? {} : { dataName: input.dataName }),
      capabilities: providerCapabilities,
      ...(knownAppRoot === undefined ? {} : { appRoot: knownAppRoot }),
    },
    input.resolution,
  );
  const capabilityContext = {
    provider,
    capabilities: providerCapabilities,
    alternatives: providerAlternatives(pluginRegistry, manifests, policyOwner.platform),
  };
  const sshAgentIntent = resolveSshAgentIntent({ landofile, globalConfig });
  const gpgAgentIntent = resolveGpgAgentIntent({ landofile, globalConfig });
  const sshAgentExtension = sshAgentExtensionForIntent(sshAgentIntent);
  const appId = AppId.make(appSlug);
  const metadata: ServicePlan["metadata"] = {
    ...encodedMetadata,
    resolvedAt: DateTime.makeUnsafe(encodedMetadata.resolvedAt),
  };
  const routerEnabled = routerEnabledFrom(globalConfig?.router, landofile.router);
  const router = yield* resolvePlanRouter({
    enabled: routerEnabled,
    manifests,
    configured: globalConfig?.defaultRouterService,
    platform: policyOwner.platform,
  });
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
  const cacheRoot = pathsService?.roots.userCacheRoot ?? resolveUserCacheRoot();
  const sourceFingerprint =
    input.mode === "validate"
      ? undefined
      : yield* readAppPlanSourceFingerprint(appRoot, landofile).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        );
  const certificateAuthority = selectContributedCertificateAuthority<CertificateAuthorityCandidateDefinition>(
    contributionGraph,
    policyOwner.platform,
    () => manifestCertificateAuthorityCandidates(manifests),
  );
  const leafLocation = certificateLeafLocation({
    certsDir: (pathsService ?? makeLandoPaths()).certsDir,
    kind: input.kind,
    id: appId,
    root: appRoot,
    identity: input.identity,
  });
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
            certificateAuthority,
            leafLocation,
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
  // Every hostEvents name is a lifecycle event, so a bad host step stops this app's plan like a
  // project lifecycle step would; commands that only read config are unaffected. Checked before
  // the steps compile, so an unreadable expression is reported against config.yml.
  if (hostEvents !== undefined && !hostEventCompileBase.skipHostEvents) {
    const configFile = pathsService?.configFile ?? "config.yml";
    const hostShellIssues = hostEventsShellIssues(hostEvents).map((issue) => ({
      ...issue,
      source: { layer: "config-file" as const, file: configFile, path: issue.path },
    }));
    if (hostShellIssues.length > 0)
      return yield* Effect.fail(
        landofileValidationError(configFile, hostShellIssues, {
          headline: "Global config hostEvents has steps that cannot run as written",
          remediation: "Fix each listed hostEvents step in config.yml, then rerun the command.",
        }),
      );
  }
  const executableSites = yield* compilePlanInvocationSites({
    sites: invocationSites,
    hostEvents: hostEventCompileBase.skipHostEvents ? undefined : hostEvents,
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
    dataName: input.dataName ?? appName,
    kind: input.kind ?? "user",
    hostProvider,
    appRoot,
    landofile: { ...cacheLandofile, provider },
    providerCapabilities,
    pluginManifests: manifests,
    pluginImplementations: plugins.coordinates,
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
      router: router.selected ?? null,
      fileSyncPolicy: fileSyncCacheInput(fileSyncPolicy, providerCapabilities, fileSyncCandidates),
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
  // Validation never touches the persisted plan; neither does a plan built from unknown plugin code.
  const planCache = input.mode !== "validate" && plugins.cacheable ? cacheService : undefined;
  if (planCache !== undefined) {
    const cached = yield* readCachedAppPlan({
      cacheRoot,
      appName: appSlug,
      appRoot,
      key: cacheKey,
      fileSystem,
    }).pipe(Effect.catch(() => Effect.succeed(null)));
    if (cached !== null && hasServiceArtifacts(cached)) {
      yield* assertRoutesCertificateCoverable(appRoot, cached.routes);
      yield* validateServiceProbes(cached);
      if (cached.fileSync.length > 0) yield* selectFileSyncEngine;
      yield* assertAuthoredNetworksSupported(provider, providerCapabilities, cached.networking);
      yield* validateServiceDependencies(appRoot, cached.services);
      yield* assertComposeKnobsSupported(capabilityContext, cached.services);
      yield* assertServiceInitSupported(provider, providerCapabilities, cached.services);
      yield* assertComposeFieldsSupported(capabilityContext, cached);
      const proven = withCommittedLiteralDigests(cached, authoredLandofile);
      return attachCompiledInvocationPlan(
        attachEffectiveTooling(proven, effectiveTooling, {
          connectionClients,
          provenance: toolingProvenance,
        }),
        executableSites,
        effectiveEventsFor(planServices(cached.services)),
      );
    }
  }

  const plannedServiceDrafts = yield* planServiceDrafts({ resolvedServices, appRoot });
  const appFeatureResult = yield* applyPreparedAppFeatures(
    {
      appName,
      appRoot,
      services: plannedServiceDrafts.map((entry) => entry.draft),
    },
    preparedApp,
  ).pipe(mapFailures((error) => appFeatureError(appRoot, error)));
  const { cloned, plannedWithClones } = yield* materializeClonedServiceDrafts(plannedServiceDrafts, {
    clones: appFeatureResult.clones,
    capabilities: providerCapabilities,
    resolvedServices,
    appRoot,
    appSlug,
  });
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
    manifests,
    configs: landofile.configs,
    plannedServiceDrafts: plannedWithClones,
    appId,
    appRoot,
    appSlug,
    appName,
    dataSlug: normalizeAppSlug(input.dataName ?? appName, appRoot),
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
  yield* router.requireRoutable(finalized.routes.length, provider, hostProvider);
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
    services: networkServicesWithClones(resolvedServices, cloned, serviceNames),
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
    ...router.globalServices(finalized.routes.length),
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
        ...(input.identity === undefined ? {} : { identity: input.identity }),
        provider,
        router: router.field(finalized.routes.length),
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
        Effect.map((decoded) => withCommittedLiteralDigests(decoded, authoredLandofile)),
      ),
      effectiveTooling,
      { connectionClients, provenance: toolingProvenance },
    ),
    executableSites,
    effectiveEventsFor(planServices(finalized.services)),
  );
  yield* assertComposeKnobsSupported(capabilityContext, plan.services);
  yield* assertServiceInitSupported(provider, providerCapabilities, plan.services);
  yield* assertAuthoredNetworksSupported(provider, providerCapabilities, plan.networking);
  yield* validateServiceProbes(plan);
  yield* assertComposeFieldsSupported(capabilityContext, plan);
  if (planCache !== undefined && !hasSkippedUnsatisfiedVersionConstraint(versionConstraints, CORE_VERSION)) {
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
      Effect.provideService(CacheService, planCache),
      Effect.catch(() => Effect.void),
    );
  }
  return plan;
});
