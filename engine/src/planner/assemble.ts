import { resolveNetworkTrustPlan } from "@lando/http-client/network-trust";
import {
  getVersionConstraintEntries,
  hasSkippedUnsatisfiedVersionConstraint,
} from "@lando/landofile/version-constraint";
import { CapabilityError, LandofileValidationError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type LandofileShape,
  type NetworkPlan,
  type NetworkingPlan,
  type ProviderCapabilities,
  type ServicePlan,
  landoNetworkingPlan,
} from "@lando/sdk/schema";
import {
  type AppPlannerError,
  CacheService,
  type ConfigService,
  type FileSystem,
  type PathsService,
  type PluginRegistry,
} from "@lando/sdk/services";
import { type Context, DateTime, Effect, Either } from "effect";
import {
  deriveAppPlanCacheKey,
  readAppPlanSourceFingerprint,
  readCachedAppPlan,
  writeCachedAppPlan,
} from "../cache/app-plan.ts";
import { resolveUserCacheRoot } from "../cache/paths.ts";
import { readProxyDefaultDomain } from "../config/proxy-default-domain.ts";
import { routerEnabledFrom } from "../config/router-config.ts";
import type { CertificateAuthorityResolver } from "../plugins/certificate-authority-resolver.ts";
import { type ComposeAppFeature, composeAppFeatures } from "../services/app-feature.ts";
import { validateServiceDependencies } from "../services/dependency-validation.ts";
import { mergeLogSources } from "../services/log-sources.ts";
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
import { normalizeAuthoredRoutes, planServiceDrafts } from "./authored.ts";
import {
  appFeatureCapabilityError,
  assertComposeKnobsSupported,
  assertComposePreservedPathsSupported,
  assertComposeProjectFieldsSupported,
  assertComposeServiceFieldsSupported,
  missingCapability,
  providerSatisfiesCapability,
} from "./compose-capabilities.ts";
import { loadComposeConfigFiles } from "./config-files.ts";
import { attachEffectiveEvents, compileEffectiveEvents } from "./effective-events.ts";
import { attachEffectiveTooling } from "./effective-tooling.ts";
import { finalizeServices } from "./endpoints.ts";
import { resolveKnownEventSet } from "./event-set.ts";
import { resolveFileSyncEngineId } from "./file-sync.ts";
import { DEFAULT_PROXY_DOMAIN, appNetworkName, normalizeAppSlug } from "./naming.ts";
import { decodeAppPlan } from "./plan-decode.ts";
import { attachScanPlans } from "./scanner-plan.ts";
import { resolveServiceConfigSources } from "./service-config-files.ts";
import {
  type ResolvedService,
  appFeatureError,
  baseDefaultFeatureIds,
  contributionId,
  resolvedServiceCacheInput,
} from "./service-types.ts";
import { authoredStorageScopes, rejectGlobalScope } from "./storage.ts";

export const planApp = (
  pluginRegistry: Context.Tag.Service<typeof PluginRegistry>,
  cacheService: Context.Tag.Service<typeof CacheService> | undefined,
  configService: Context.Tag.Service<typeof ConfigService> | undefined,
  fileSystem: Context.Tag.Service<typeof FileSystem> | undefined,
  pathsService: Context.Tag.Service<typeof PathsService> | undefined,
  certificateAuthorityResolver: Context.Tag.Service<typeof CertificateAuthorityResolver> | undefined,
  landofile: LandofileShape,
  providerCapabilities: ProviderCapabilities,
): Effect.Effect<AppPlan, AppPlannerError> =>
  Effect.gen(function* () {
    const {
      services: seeds,
      effectiveTooling,
      appRoot,
      appName,
      landofilePath,
      host,
      encodedMetadata,
      globalConfig,
      appDefaults,
      provider,
      manifests,
      topLevelEnvFiles,
    } = yield* resolveKnownEventSet({
      pluginRegistry,
      configService,
      fileSystem,
      pathsService,
      landofile,
      capabilities: providerCapabilities,
    });
    const appSlug = normalizeAppSlug(appName, appRoot);
    const sshAgentIntent = resolveSshAgentIntent({ landofile, globalConfig });
    const gpgAgentIntent = resolveGpgAgentIntent({ landofile, globalConfig });
    const sshAgentExtension = sshAgentExtensionForIntent(sshAgentIntent);
    const appId = AppId.make(appSlug);
    const metadata: ServicePlan["metadata"] = {
      ...encodedMetadata,
      resolvedAt: DateTime.unsafeMake(encodedMetadata.resolvedAt),
    };
    const routerEnabled = routerEnabledFrom(globalConfig?.router, landofile.router);
    const networkPlan = yield* Effect.try({
      try: () => resolveNetworkTrustPlan({ network: globalConfig?.network }, process.env),
      catch: (cause) =>
        new LandofileValidationError({
          message: `Global network trust configuration is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
          file: landofilePath,
          issues: ["network"],
        }),
    });
    const globalCas = yield* loadGlobalSecurityCas(appRoot, networkPlan.caCertPaths);
    const fileSyncEngineId =
      providerCapabilities.bindMountPerformance === "slow" ? resolveFileSyncEngineId(manifests) : undefined;
    const cacheRoot = resolveUserCacheRoot();
    const sourceFingerprint = yield* readAppPlanSourceFingerprint(appRoot, landofile).pipe(
      Effect.catchAll(() => Effect.succeed(undefined)),
    );
    const appFeatureRefs: Array<{ readonly id: string; readonly pluginId: string }> = [];
    const seenAppFeatureIds = new Set<string>();
    for (const manifest of manifests) {
      for (const entry of manifest.contributes?.appFeatures ?? []) {
        const id = contributionId(entry);
        if (seenAppFeatureIds.has(id)) continue;
        seenAppFeatureIds.add(id);
        appFeatureRefs.push({ id, pluginId: manifest.name });
      }
    }
    const appFeatures: ComposeAppFeature[] = [];
    for (const ref of appFeatureRefs) {
      const definition = yield* pluginRegistry.loadAppFeature(ref.id).pipe(
        Effect.mapError(
          (error) =>
            new LandofileValidationError({
              message: error instanceof Error ? error.message : `App feature ${ref.id} is not registered.`,
              file: landofilePath,
              issues: [`plugins.${ref.pluginId}.appFeatures.${ref.id}`],
            }),
        ),
      );
      appFeatures.push({ id: ref.id, definition, pluginId: ref.pluginId });
    }

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
      } = seed;
      const service = seed.authoredService;
      const routes = yield* normalizeAuthoredRoutes({ name, service, landofile });
      const configSourceInputs = yield* resolveServiceConfigSources({
        appRoot,
        serviceName: name,
        config: service.config,
      });
      const resolvedAuthored = authoredStorageScopes(appRoot, name, resolution.normalizedConfig);
      if (resolvedAuthored.invalidCacheEntry !== undefined)
        yield* Effect.fail(resolvedAuthored.invalidCacheEntry);
      if (resolvedAuthored.globalEntry !== undefined) {
        yield* Effect.fail(rejectGlobalScope(appRoot, name, resolvedAuthored.globalEntry));
      }
      const authoredStores = new Map(authored.byStore);
      for (const [store, info] of resolvedAuthored.byStore) authoredStores.set(store, info);
      const storageAuthored = { ...authored, byStore: authoredStores };
      const mergedLogSources = mergeLogSources({
        appRoot,
        serviceName: name,
        base: resolution.base,
        typeSources: resolution.logSources ?? [],
        userSources: service.logs ?? [],
      });
      const logSources = yield* Either.isLeft(mergedLogSources)
        ? Effect.fail(mergedLogSources.left)
        : Effect.succeed(mergedLogSources.right);
      const resolutionFeatureIds = new Set(resolution.features.map((feature) => feature.id));
      const baseDefaultIds = baseDefaultFeatureIds(resolution.base).filter(
        (id) => !resolutionFeatureIds.has(id),
      );
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
              routes,
              defaultRouteHostname:
                routes.length === 0 ? `${name}.${appSlug}.${DEFAULT_PROXY_DOMAIN}` : undefined,
              resolveCertificateAuthority: certificateAuthorityResolver?.resolve,
              fileSystem,
            })
          : undefined;
      const plannerSeededFeatures = [
        securityFeature,
        certsFeature,
        { id: SSH_AGENT_FEATURE_ID, config: sshAgentExtension },
      ].filter((feature): feature is NonNullable<typeof feature> => feature !== undefined);
      const featureRefs = [
        ...(resolution.base === "lando" && gpgAgentIntent.forward ? [{ id: "lando.gpg-agent" }] : []),
        ...baseDefaultIds.map((id) => ({ id })),
        ...resolution.features.map((featureRef) => ({
          id: featureRef.id,
          ...(featureRef.config === undefined ? {} : { config: featureRef.config }),
        })),
      ].map(
        (featureRef) => plannerSeededFeatures.find((seeded) => seeded.id === featureRef.id) ?? featureRef,
      );
      if (
        sshAgentIntent.mode === "host" &&
        featureRefs.some((feature) => feature.id === SSH_AGENT_FEATURE_ID) &&
        !providerSatisfiesCapability(providerCapabilities, "agentSocket")
      ) {
        yield* Effect.fail(
          missingCapability(
            provider,
            name,
            SSH_AGENT_FEATURE_ID,
            "agentSocket",
            "Select a provider that advertises agentSocket delivery or set sshAgent.sidecar to true to use best-effort sidecar forwarding.",
          ),
        );
      }
      if (
        gpgAgentIntent.forward &&
        resolution.base === "lando" &&
        providerSatisfiesCapability(providerCapabilities, "agentSocket") === false
      ) {
        yield* Effect.fail(
          missingCapability(
            provider,
            name,
            "lando.gpg-agent",
            "agentSocket",
            "Select a provider with agentSocket delivery or disable gpgAgent.forward.",
          ),
        );
      }
      resolvedServices.push({
        routes,
        name,
        service: pinnedService,
        authored: storageAuthored,
        serviceType,
        resolution,
        logSources,
        baseDefaultIds,
        featureRefs,
        resolvedArtifactTag,
        envFileInputs,
        projectFiles,
        configSourceInputs,
      });
    }
    const versionConstraints = getVersionConstraintEntries(landofile, landofilePath);
    const effectiveEvents = compileEffectiveEvents({ landofile });
    const { sshAgent: _sshAgent, gpgAgent: _gpgAgent, ...cacheLandofile } = landofile;
    const cacheKey = deriveAppPlanCacheKey({
      appRoot,
      landofile: { ...cacheLandofile, provider },
      providerCapabilities,
      pluginManifests: manifests,
      config: AppDefaults.cacheInput(routerEnabled, globalConfig?.scanner, {
        ...appDefaults,
        sshAgentMode: sshAgentIntent.mode,
        gpgAgentForward: gpgAgentIntent.forward,
      }),
      ...(sourceFingerprint === undefined ? {} : { sourceFingerprint }),
      versionConstraints,
      serviceInputs: {
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
      const cached = yield* readCachedAppPlan({ cacheRoot, appName: appSlug, appRoot, key: cacheKey }).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      );
      if (cached !== null) {
        yield* validateServiceDependencies(appRoot, cached.services);
        yield* assertComposeKnobsSupported(provider, providerCapabilities, cached.services);
        yield* assertComposeServiceFieldsSupported(provider, providerCapabilities, cached.services);
        yield* assertComposePreservedPathsSupported(provider, providerCapabilities, cached.services);
        yield* assertComposeProjectFieldsSupported(provider, providerCapabilities, cached.extensions);
        return attachEffectiveEvents(attachEffectiveTooling(cached, effectiveTooling), effectiveEvents);
      }
    }

    const plannedServiceDrafts = yield* planServiceDrafts({
      pluginRegistry,
      resolvedServices,
      provider,
      appName,
      appRoot,
      host,
    });
    const appFeatureResult = yield* composeAppFeatures({
      appName,
      appRoot,
      services: plannedServiceDrafts.map((entry) => entry.draft),
      features: appFeatures,
    }).pipe(Effect.mapError((error) => appFeatureError(appRoot, error)));
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

    const defaultDomain =
      globalConfig === undefined ? DEFAULT_PROXY_DOMAIN : readProxyDefaultDomain(globalConfig);
    const finalized = yield* finalizeServices({
      plannedServiceDrafts,
      appId,
      appRoot,
      appName,
      appSlug,
      defaultDomain,
      provider,
      providerCapabilities,
      metadata,
      fileSyncEngineId,
    });
    if (routerEnabled && finalized.routes.length > 0 && !providerCapabilities.sharedCrossAppNetwork) {
      yield* Effect.fail(
        new CapabilityError({
          message: "Routes require provider capability sharedCrossAppNetwork.",
          feature: "routes",
          capability: "sharedCrossAppNetwork",
          providerId: String(provider),
          remediation: "Choose a provider with shared cross-app networking or remove the authored routes.",
        }),
      );
    }
    const serviceNames = Object.keys(finalized.services);
    const hasServices = serviceNames.length > 0;
    const networks: ReadonlyArray<NetworkPlan> = hasServices
      ? [{ name: appNetworkName(appSlug), shared: false, driver: "bridge" }]
      : [];
    const networking: NetworkingPlan | undefined = hasServices
      ? landoNetworkingPlan({
          slug: appSlug,
          serviceNames,
          sharedCrossAppNetwork: providerCapabilities.sharedCrossAppNetwork,
          serviceHostnames: finalized.serviceHostnames,
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
    const plan = attachEffectiveEvents(
      attachEffectiveTooling(
        yield* decodeAppPlan(appRoot, {
          id: appId,
          name: appName,
          slug: appSlug,
          root: AbsolutePath.make(appRoot),
          provider,
          router: { enabled: routerEnabled },
          services: finalized.services,
          routes: finalized.routes,
          networks,
          ...(networking !== undefined ? { networking } : {}),
          stores: finalized.stores,
          fileSync: finalized.fileSync,
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
        }).pipe(Effect.map((decoded) => attachScanPlans(decoded, globalConfig?.scanner, resolvedServices))),
        effectiveTooling,
      ),
      effectiveEvents,
    );
    yield* assertComposeKnobsSupported(provider, providerCapabilities, plan.services);
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
      }).pipe(
        Effect.provideService(CacheService, cacheService),
        Effect.catchAll(() => Effect.void),
      );
    }
    return plan;
  });
