import { type Context, DateTime, Effect, Either, ParseResult, Schema } from "effect";

import { resolveNetworkTrustPlan } from "@lando/http-client/network-trust";
import { getLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { getLandofileReferencedFiles } from "@lando/landofile/load-expression-provenance";
import {
  getVersionConstraintEntries,
  hasSkippedUnsatisfiedVersionConstraint,
} from "@lando/landofile/version-constraint";
import {
  CapabilityError,
  LandofileValidationError,
  type NotImplementedError,
  type PublicationUnsupportedError,
  ServiceTypeCollisionError,
} from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  AppPlan,
  type LandofileShape,
  type NetworkPlan,
  type NetworkingPlan,
  type ProviderCapabilities,
  type ServiceConfig,
  ServiceName,
  type ServicePlan,
  landoNetworkingPlan,
} from "@lando/sdk/schema";
import {
  CacheService,
  type ConfigService,
  type FileSystem,
  type PathsService,
  type PluginRegistry,
} from "@lando/sdk/services";

import {
  deriveAppPlanCacheKey,
  readAppPlanSourceFingerprint,
  readCachedAppPlan,
  writeCachedAppPlan,
} from "../cache/app-plan.ts";
import { resolveUserCacheRoot } from "../cache/paths.ts";
import type { CertificateAuthorityResolver } from "../plugins/certificate-authority-resolver.ts";
import {
  CAPABILITY_DEFAULT_PROVIDER_ID,
  readProviderEnvVar,
  resolveProviderSelection,
} from "../providers/precedence.ts";
import { type ComposeAppFeature, composeAppFeatures } from "../services/app-feature.ts";
import { isComposeBuild } from "../services/compose-build-artifact.ts";
import { validateServiceDependencies } from "../services/dependency-validation.ts";
import { mergeLogSources } from "../services/log-sources.ts";
import { loadGlobalSecurityCas, resolveSecurityFeature } from "../services/network-inject.ts";
import { resolveCertsFeature } from "../services/service-certs.ts";
import {
  HOST_PROXY_PLAN_EXTENSION_KEY,
  hostProxyExtensionForCapabilities,
} from "../subsystems/host-proxy/plan-extension.ts";
import { CORE_VERSION } from "../version.ts";
import { planServiceDrafts } from "./authored.ts";
import {
  appFeatureCapabilityError,
  assertComposeKnobsSupported,
  assertComposePreservedPathsSupported,
  assertComposeProjectFieldsSupported,
  assertComposeServiceFieldsSupported,
  providerSatisfiesCapability,
} from "./compose-capabilities.ts";
import { loadComposeConfigFiles } from "./config-files.ts";
import { attachEffectiveEvents, compileEffectiveEvents } from "./effective-events.ts";
import { attachEffectiveTooling, compileEffectiveTooling } from "./effective-tooling.ts";
import { finalizeServices } from "./endpoints.ts";
import { loadServiceEnvFiles, loadTopLevelEnvFiles } from "./env-files.ts";
import { resolveFileSyncEngineId } from "./file-sync.ts";
import { DEFAULT_PROXY_DOMAIN, appNetworkName, normalizeAppSlug } from "./naming.ts";
import {
  type ResolvedService,
  appFeatureError,
  baseDefaultFeatureIds,
  contributionId,
  loadServiceTypeWithVersion,
  resolveHostFacts,
  resolvePinnedArtifactTag,
  servicePlanError,
  serviceTypeCollision,
  serviceTypeFor,
  unsupportedServiceType,
} from "./service-types.ts";
import { authoredStorageScopes, rejectGlobalScope } from "./storage.ts";

const validationIssues = (cause: unknown): ReadonlyArray<string> => {
  if (ParseResult.isParseError(cause)) {
    return ParseResult.ArrayFormatter.formatErrorSync(cause).map((issue) =>
      issue.path.length === 0 ? issue.message : issue.path.join("."),
    );
  }
  return [cause instanceof Error ? cause.message : "Invalid app plan."];
};

const decodeAppPlan = (appRoot: string, plan: unknown): Effect.Effect<AppPlan, LandofileValidationError> => {
  const decoded = Schema.decodeUnknownEither(AppPlan)(plan);
  if (Either.isRight(decoded)) return Effect.succeed(decoded.right);
  const issues = validationIssues(decoded.left);
  return Effect.fail(
    new LandofileValidationError({
      message: `Planned AppPlan is invalid: ${issues.join(", ")}.`,
      file: `${appRoot}/.lando.yml`,
      issues,
    }),
  );
};

export const planApp = (
  pluginRegistry: Context.Tag.Service<typeof PluginRegistry>,
  cacheService: Context.Tag.Service<typeof CacheService> | undefined,
  configService: Context.Tag.Service<typeof ConfigService> | undefined,
  fileSystem: Context.Tag.Service<typeof FileSystem> | undefined,
  pathsService: Context.Tag.Service<typeof PathsService> | undefined,
  certificateAuthorityResolver: Context.Tag.Service<typeof CertificateAuthorityResolver> | undefined,
  landofile: LandofileShape,
  providerCapabilities: ProviderCapabilities,
): Effect.Effect<
  AppPlan,
  LandofileValidationError | CapabilityError | NotImplementedError | PublicationUnsupportedError
> => {
  const appRoot = getLandofileAppRoot(landofile) ?? process.cwd();
  const landofilePath = `${appRoot}/.lando.yml`;
  const appName = landofile.name ?? "app";
  const appSlug = normalizeAppSlug(appName, appRoot);
  const appId = AppId.make(appSlug);
  const host = resolveHostFacts();
  const resolvedAt = new Date().toISOString();
  const encodedMetadata = { resolvedAt, source: landofilePath, runtime: 4 as const };
  const metadata: ServicePlan["metadata"] = {
    resolvedAt: DateTime.unsafeMake(resolvedAt),
    source: landofilePath,
    runtime: 4 as const,
  };

  return Effect.gen(function* () {
    const globalConfig =
      configService === undefined
        ? undefined
        : yield* configService.load.pipe(
            Effect.mapError(
              (cause) =>
                new LandofileValidationError({
                  message: `Global configuration could not be loaded for service network injection: ${cause.message}`,
                  file: landofilePath,
                  issues: ["network"],
                }),
            ),
          );
    const configProvider = globalConfig?.defaultProviderId;
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
    const envProvider = readProviderEnvVar(process.env);
    const provider = resolveProviderSelection({
      ...(landofile.provider === undefined ? {} : { landofile: landofile.provider }),
      ...(envProvider === undefined ? {} : { env: envProvider }),
      ...(configProvider === undefined || configProvider === null ? {} : { config: configProvider }),
      capabilityDefault: CAPABILITY_DEFAULT_PROVIDER_ID,
    }).providerId;
    const manifests = yield* pluginRegistry.list.pipe(
      Effect.mapError(
        (error) =>
          new LandofileValidationError({
            message: `Failed to enumerate plugin contributions: ${error instanceof Error ? error.message : String(error)}.`,
            file: landofilePath,
            issues: [],
          }),
      ),
    );
    const fileSyncEngineId =
      providerCapabilities.bindMountPerformance === "slow" ? resolveFileSyncEngineId(manifests) : undefined;
    const cacheRoot = resolveUserCacheRoot();
    const sourceFingerprint = yield* readAppPlanSourceFingerprint(
      appRoot,
      getLandofileReferencedFiles(landofile),
    ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    const registeredServiceTypeIds = manifests.flatMap((manifest) =>
      (manifest.contributes?.serviceTypes ?? []).map(contributionId),
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

    const topLevelEnvFiles = yield* loadTopLevelEnvFiles({
      appRoot,
      envFiles: landofile.env_file ?? [],
      fileSystem,
    });
    const composeConfigFileInputs = yield* loadComposeConfigFiles({
      appRoot,
      landofile,
      fileSystem,
      capabilities: providerCapabilities,
    });
    const resolvedServices: ResolvedService[] = [];
    for (const [name, service] of Object.entries(landofile.services ?? {})) {
      const loadedEnvFiles = yield* loadServiceEnvFiles({ appRoot, serviceName: name, service, fileSystem });
      const hasEnvFiles = topLevelEnvFiles.inputs.length > 0 || loadedEnvFiles.inputs.length > 0;
      const serviceWithEnvironment: ServiceConfig = !hasEnvFiles
        ? service
        : {
            ...service,
            environment: {
              ...topLevelEnvFiles.environment,
              ...(loadedEnvFiles.environment ?? {}),
            },
          };
      if (
        serviceWithEnvironment.image !== undefined &&
        serviceWithEnvironment.build !== undefined &&
        isComposeBuild(serviceWithEnvironment.build)
      ) {
        yield* Effect.fail(
          new LandofileValidationError({
            message: `Service ${name} must declare exactly one of image or a Compose build, not both. Remove image or replace build with a Lando build-script block.`,
            file: landofilePath,
            issues: [`services.${name}.build`],
          }),
        );
      }
      const authored = authoredStorageScopes(appRoot, name, serviceWithEnvironment);
      if (authored.invalidCacheEntry !== undefined) yield* Effect.fail(authored.invalidCacheEntry);
      if (authored.globalEntry !== undefined) {
        yield* Effect.fail(rejectGlobalScope(appRoot, name, authored.globalEntry));
      }

      const serviceTypeId = serviceTypeFor(name, serviceWithEnvironment);
      const { serviceType, version } = yield* loadServiceTypeWithVersion(pluginRegistry, serviceTypeId).pipe(
        Effect.mapError((error) =>
          error instanceof ServiceTypeCollisionError
            ? serviceTypeCollision(appRoot, name, error)
            : unsupportedServiceType(appRoot, name, serviceTypeId, registeredServiceTypeIds),
        ),
      );
      const resolvedArtifactTag = yield* resolvePinnedArtifactTag(appRoot, name, serviceType, version);
      const pinnedService: ServiceConfig =
        resolvedArtifactTag === undefined
          ? serviceWithEnvironment
          : { ...serviceWithEnvironment, image: resolvedArtifactTag };
      const resolution = yield* serviceType
        .resolve({
          name,
          service: pinnedService,
          appRoot,
          appName,
          provider,
          primary: name === "web",
          metadata: encodedMetadata,
          host,
          capabilities: providerCapabilities,
        })
        .pipe(Effect.mapError((error) => servicePlanError(appRoot, name, error)));
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
      const authoredRoutes = [
        ...(pinnedService.routes ?? []),
        ...(landofile.proxy?.[ServiceName.make(name)] ?? []),
      ];
      const certsFeature =
        resolution.base === "lando"
          ? yield* resolveCertsFeature({
              appName: appSlug,
              appRoot,
              serviceName: name,
              certs: resolution.normalizedConfig.certs ?? pinnedService.certs,
              hostnames: pinnedService.hostnames ?? [],
              routes: authoredRoutes,
              defaultRouteHostname:
                authoredRoutes.length === 0 ? `${name}.${appSlug}.${DEFAULT_PROXY_DOMAIN}` : undefined,
              resolveCertificateAuthority: certificateAuthorityResolver?.resolve,
              fileSystem,
            })
          : undefined;
      const plannerSeededFeatures = [securityFeature, certsFeature].filter(
        (feature): feature is NonNullable<typeof feature> => feature !== undefined,
      );
      const featureRefs = [
        ...baseDefaultIds.map((id) => ({ id })),
        ...resolution.features.map((featureRef) => ({
          id: featureRef.id,
          ...(featureRef.config === undefined ? {} : { config: featureRef.config }),
        })),
      ].map(
        (featureRef) => plannerSeededFeatures.find((seeded) => seeded.id === featureRef.id) ?? featureRef,
      );
      resolvedServices.push({
        name,
        service: pinnedService,
        authored: storageAuthored,
        serviceType,
        resolution,
        logSources,
        baseDefaultIds,
        featureRefs,
        resolvedArtifactTag,
        envFileInputs: loadedEnvFiles.inputs,
      });
    }

    const versionConstraints = getVersionConstraintEntries(landofile, landofilePath);
    const effectiveTooling = compileEffectiveTooling({
      landofile,
      services: resolvedServices.map((entry) => ({
        name: entry.name,
        ...(entry.resolution.tooling === undefined ? {} : { tooling: entry.resolution.tooling }),
      })),
    });
    const effectiveEvents = compileEffectiveEvents({ landofile });
    const cacheKey = deriveAppPlanCacheKey({
      appRoot,
      landofile: { ...landofile, provider },
      providerCapabilities,
      pluginManifests: manifests,
      ...(sourceFingerprint === undefined ? {} : { sourceFingerprint }),
      versionConstraints,
      serviceInputs: {
        landofile: landofile.services ?? {},
        composition: {
          topLevelEnvFileInputs: topLevelEnvFiles.inputs,
          composeConfigFileInputs,
          services: resolvedServices.map((entry) => ({
            name: entry.name,
            serviceType: entry.serviceType.id,
            base: entry.resolution.base,
            normalizedConfig: entry.resolution.normalizedConfig,
            tooling: entry.resolution.tooling ?? {},
            logSources: entry.logSources,
            featureRefs: entry.featureRefs,
            envFileInputs: entry.envFileInputs,
            ...(entry.resolvedArtifactTag === undefined
              ? {}
              : { resolvedArtifactTag: entry.resolvedArtifactTag }),
          })),
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
      landofileProxy: landofile.proxy,
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

    const finalized = yield* finalizeServices({
      plannedServiceDrafts,
      appId,
      appRoot,
      appSlug,
      provider,
      providerCapabilities,
      metadata,
      fileSyncEngineId,
    });
    if (finalized.routes.length > 0 && !providerCapabilities.sharedCrossAppNetwork) {
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
      ...(finalized.routes.length > 0 ? ["traefik"] : []),
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
          services: finalized.services,
          routes: finalized.routes,
          networks,
          ...(networking !== undefined ? { networking } : {}),
          stores: finalized.stores,
          fileSync: finalized.fileSync,
          metadata: encodedMetadata,
          extensions:
            hostProxyExtension === undefined && !hasComposeProjectExtension
              ? {}
              : {
                  ...(hostProxyExtension === undefined
                    ? {}
                    : { [HOST_PROXY_PLAN_EXTENSION_KEY]: hostProxyExtension }),
                  ...(hasComposeProjectExtension ? { compose: composeProjectExtension } : {}),
                },
          ...(requiredGlobalServices.length === 0
            ? {}
            : { requires: { globalServices: [...new Set(requiredGlobalServices)] } }),
        }),
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
};
