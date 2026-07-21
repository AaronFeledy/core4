import { createHash } from "node:crypto";
import * as os from "node:os";

import { type Context, DateTime, Effect, Either, Layer, ParseResult, Schema } from "effect";

import {
  CapabilityError,
  LandofileValidationError,
  NotImplementedError,
  type PluginLoadError,
  type PluginManifestError,
  ServiceTypeCollisionError,
} from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  AppPlan,
  type DataStoreMountPlan,
  type FileSyncPlan,
  type FileSyncSessionSpec,
  type LandofileShape,
  type LogSource,
  type NetworkPlan,
  type NetworkingPlan,
  PortablePath,
  type ProviderCapabilities,
  type ProviderId,
  type RoutePlan,
  type ServiceConfig,
  ServiceName,
  ServicePlan,
  type StorageScope,
  fileSyncVolumeName,
  isHostPublishedEndpoint,
  landoNetworkingPlan,
  sameAppMountTarget,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  type AppPlannerOptions,
  CacheService,
  ConfigService,
  PluginRegistry,
  type ServiceBuildStepIntent,
  type ServiceType,
  type ServiceTypeHostFacts,
  type ServiceTypeResolution,
} from "@lando/sdk/services";

import {
  CAPABILITY_DEFAULT_PROVIDER_ID,
  readProviderEnvVar,
  resolveProviderSelection,
} from "../providers/precedence.ts";

import {
  deriveAppPlanCacheKey,
  readAppPlanSourceFingerprint,
  readCachedAppPlan,
  writeCachedAppPlan,
} from "../cache/app-plan.ts";
import { resolveUserCacheRoot } from "../cache/paths.ts";
import {
  getVersionConstraintEntries,
  hasSkippedUnsatisfiedVersionConstraint,
} from "../config/version-constraint.ts";
import {
  HOST_PROXY_PLAN_EXTENSION_KEY,
  hostProxyExtensionForCapabilities,
} from "../subsystems/host-proxy/plan-extension.ts";
import { CORE_VERSION } from "../version.ts";
import { type AppFeatureServiceDraft, type ComposeAppFeature, composeAppFeatures } from "./app-feature.ts";
import { L337_BASE_DEFAULT_FEATURE_IDS } from "./base/l337.ts";
import { LANDO_BASE_DEFAULT_FEATURE_IDS } from "./base/lando.ts";
import type { DraftServicePlan } from "./draft.ts";
import { sortRecord } from "./draft.ts";
import { type ComposeServiceFeature, composeService } from "./feature.ts";
import { mergeLogSources } from "./log-sources.ts";
import { redirectLogSourceBuildSteps, runtimeFollowLogSources } from "./redirect-log-sources.ts";

export { AppPlanner } from "@lando/sdk/services";

type ContributionRef = string | { readonly id: string };

const contributionId = (entry: ContributionRef): string => (typeof entry === "string" ? entry : entry.id);

const GLOBAL_SCOPE_REMEDIATION =
  "Use scope: app or scope: service. Storage scope: global is deferred until global app support lands.";

const validationIssues = (cause: unknown): ReadonlyArray<string> => {
  if (ParseResult.isParseError(cause)) {
    return ParseResult.ArrayFormatter.formatErrorSync(cause).map((issue) =>
      issue.path.length === 0 ? issue.message : issue.path.join("."),
    );
  }
  return [cause instanceof Error ? cause.message : "Invalid app plan."];
};

const imageIs = (image: string | undefined, name: string): boolean =>
  image === name || image?.startsWith(`${name}:`) === true;

const serviceTypeFor = (name: string, service: ServiceConfig): string => {
  if (service.type !== undefined) return service.type;
  const image = service.image;
  if (image?.startsWith("node:22")) return "node:22";
  if (image?.startsWith("node:")) return "node:lts";
  if (imageIs(image, "postgres")) return "postgres";
  if (imageIs(image, "mysql")) return "mysql";
  if (imageIs(image, "mariadb")) return "mariadb";
  if (imageIs(image, "redis")) return "redis";
  if (imageIs(image, "nginx")) return "nginx";
  if (imageIs(image, "httpd")) return "apache";
  if (image?.startsWith("php:8.2")) return "php:8.2";
  if (image?.startsWith("php:8.3")) return "php:8.3";
  if (image?.startsWith("python:3.12")) return "python:3.12";
  if (image?.startsWith("ruby:3.3")) return "ruby:3.3";
  if (image?.startsWith("golang:1.22")) return "go:1.22";
  if (image?.startsWith("golang:1.23")) return "go:1.23";
  return name;
};

interface LoadedServiceType {
  readonly serviceType: ServiceType;
  readonly version: string | undefined;
}

/**
 * Resolve an authored `type:` reference to a registered service type. An exact
 * id match wins first, so type ids that legitimately contain a colon (e.g.
 * `php:8.2`) load whole. Only when no exact id is registered is the reference
 * split at the RIGHTMOST colon into `<name>:<version>` and the bare name retried
 * for declarative version pinning. A cycle/depth rejection on the exact id is
 * surfaced as-is and never silently retried as a versioned reference.
 */
const loadServiceTypeWithVersion = (
  pluginRegistry: Context.Tag.Service<typeof PluginRegistry>,
  reference: string,
): Effect.Effect<LoadedServiceType, PluginLoadError | PluginManifestError | ServiceTypeCollisionError> =>
  pluginRegistry.loadServiceType(reference).pipe(
    Effect.map((serviceType) => ({ serviceType, version: undefined as string | undefined })),
    Effect.catchAll((error) => {
      if (error instanceof ServiceTypeCollisionError) return Effect.fail(error);
      const lastColon = reference.lastIndexOf(":");
      if (lastColon <= 0) return Effect.fail(error);
      const typeName = reference.slice(0, lastColon);
      const version = reference.slice(lastColon + 1);
      if (version.length === 0) return Effect.fail(error);
      return pluginRegistry
        .loadServiceType(typeName)
        .pipe(Effect.map((serviceType) => ({ serviceType, version: version as string | undefined })));
    }),
  );

/**
 * Declarative version pinning. With no version, no pin is computed
 * (legacy image defaults stand). With a version: an exact `artifacts:` entry
 * wins; otherwise a version listed in `versions:` resolves to `<id>:<version>`
 * by convention. A version absent from a declared, non-empty `versions:` list
 * is rejected so `versions:` cannot be silently bypassed.
 */
const resolvePinnedArtifactTag = (
  appRoot: string,
  serviceName: string,
  serviceType: ServiceType,
  version: string | undefined,
): Effect.Effect<string | undefined, LandofileValidationError> => {
  if (version === undefined) return Effect.succeed(undefined);
  const pinned = serviceType.artifacts?.[version];
  if (pinned !== undefined) return Effect.succeed(pinned);
  const declaredVersions = serviceType.versions;
  if (declaredVersions !== undefined && declaredVersions.length > 0 && !declaredVersions.includes(version)) {
    return Effect.fail(
      new LandofileValidationError({
        message: `Service ${serviceName} requests unsupported version ${version} of service type ${serviceType.id}. Supported versions: ${[...declaredVersions].sort().join(", ")}.`,
        file: `${appRoot}/.lando.yml`,
        issues: [`services.${serviceName}.type`],
      }),
    );
  }
  return Effect.succeed(`${serviceType.id}:${version}`);
};

const unsupportedServiceType = (
  appRoot: string,
  serviceName: string,
  serviceType: string,
  registeredTypeIds: ReadonlyArray<string>,
) => {
  const colonIdx = serviceType.indexOf(":");
  const prefix = colonIdx > 0 ? serviceType.slice(0, colonIdx + 1) : null;
  const familyMatches = prefix === null ? [] : registeredTypeIds.filter((id) => id.startsWith(prefix)).sort();
  let remediation = "";
  if (familyMatches.length > 0) {
    remediation = ` Supported alternatives: ${familyMatches.join(", ")}.`;
  } else if (registeredTypeIds.length > 0) {
    remediation = ` Registered service types: ${[...registeredTypeIds].sort().join(", ")}.`;
  }
  return new LandofileValidationError({
    message: `Unsupported service type ${serviceType} for service ${serviceName}.${remediation}`,
    file: `${appRoot}/.lando.yml`,
    issues: [`services.${serviceName}.type`],
  });
};

const serviceTypeCollision = (
  appRoot: string,
  serviceName: string,
  error: ServiceTypeCollisionError,
): LandofileValidationError =>
  new LandofileValidationError({
    message: error.remediation === undefined ? error.message : `${error.message} ${error.remediation}`,
    file: `${appRoot}/.lando.yml`,
    issues: [`services.${serviceName}.type`],
  });

const missingCapability = (
  providerId: ProviderId,
  serviceName: string,
  feature: string,
  capability: keyof ProviderCapabilities,
  remediation: string,
) =>
  new CapabilityError({
    message: `Service ${serviceName} requires provider capability ${String(capability)} for ${feature}.`,
    service: serviceName,
    feature,
    capability: String(capability),
    providerId: String(providerId),
    remediation,
  });

const serviceBindRemediation = (serviceName: string) =>
  `Choose a provider with bind mount support or remove bind mounts from service ${serviceName}.`;

const serviceArtifactBuildRemediation = (serviceName: string) =>
  `Choose a provider with artifact build support or replace the build artifact for service ${serviceName} with a pre-built image reference.`;

const servicePlanError = (appRoot: string, serviceName: string, cause: unknown) =>
  new LandofileValidationError({
    message: cause instanceof Error ? cause.message : `Invalid service ${serviceName}.`,
    file: `${appRoot}/.lando.yml`,
    issues: [`services.${serviceName}`],
  });

const appFeatureError = (appRoot: string, cause: unknown) =>
  new LandofileValidationError({
    message: cause instanceof Error ? cause.message : "Invalid app-feature composition.",
    file: `${appRoot}/.lando.yml`,
    issues: ["appFeatures"],
  });

// Boolean capability => true; enum capability => not the "none" (unsupported) literal.
const providerSatisfiesCapability = (
  providerCapabilities: ProviderCapabilities,
  capability: keyof ProviderCapabilities,
): boolean => {
  const value = providerCapabilities[capability];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value !== "none";
  return value !== undefined;
};

const appFeatureCapabilityError = (
  providerId: ProviderId,
  feature: string,
  capability: keyof ProviderCapabilities,
) =>
  new CapabilityError({
    message: `App feature ${feature} requires provider capability ${String(capability)}.`,
    feature,
    capability: String(capability),
    providerId: String(providerId),
    remediation: `Choose a provider that supports ${String(capability)} or remove the app feature requiring it.`,
  });

const bindRealization = (providerCapabilities: ProviderCapabilities) =>
  providerCapabilities.bindMountPerformance === "slow" ? "accelerated" : "passthrough";

/**
 * Universal default excludes merged into every service's `appMount.excludes`.
 * Service types may contribute additional framework-aware presets on top of
 * these (e.g. `__pycache__` for Python, `.bundle` for Ruby).
 */
export const FILE_SYNC_DEFAULT_EXCLUDES: ReadonlyArray<string> = ["node_modules", "vendor", ".git", "tmp"];

export const DEFAULT_PROXY_DOMAIN = "lndo.site";

export const mergeDefaultExcludes = (servicePlan: ServicePlan): ServicePlan => {
  const appMount = servicePlan.appMount;
  if (appMount === undefined) return servicePlan;
  const seen = new Set<string>();
  const merged: Array<string> = [];
  for (const e of [...FILE_SYNC_DEFAULT_EXCLUDES, ...(appMount.excludes ?? [])]) {
    if (!seen.has(e)) {
      seen.add(e);
      merged.push(e);
    }
  }
  return { ...servicePlan, appMount: { ...appMount, excludes: merged } };
};

const kebab = (raw: string): string => {
  const ascii = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii.length === 0 ? "shadow" : ascii;
};

const shortHash = (input: string): string => createHash("sha256").update(input).digest("hex").slice(0, 8);

const appNetworkName = (slug: string): string => `lando-${slug}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

const collectFileSyncEntries = (params: {
  readonly appId: ReturnType<typeof AppId.make>;
  readonly appRoot: string;
  readonly appName: string;
  readonly serviceName: string;
  readonly servicePlan: ServicePlan;
  readonly engineId: string;
}): ReadonlyArray<FileSyncPlan> => {
  const { appId, appRoot, appName, serviceName, servicePlan, engineId } = params;
  const entries: Array<FileSyncPlan> = [];
  const app = {
    kind: "user" as const,
    id: appId,
    root: AbsolutePath.make(appRoot),
  };
  const branded = ServiceName.make(serviceName);
  const appMount = servicePlan.appMount;
  if (appMount !== undefined && appMount.realization === "accelerated") {
    const session: FileSyncSessionSpec = {
      app,
      service: branded,
      mountKey: "app-mount",
      source: appMount.source,
      target: {
        _tag: "volume",
        name: fileSyncVolumeName(appName, serviceName, "app-mount"),
        path: appMount.target,
      },
      mode: "two-way-safe",
      excludes: appMount.excludes,
    };
    entries.push({ engineId, session });
  }
  for (const [index, mount] of servicePlan.mounts.entries()) {
    if (mount.type !== "bind" || mount.realization !== "accelerated") continue;
    if (sameAppMountTarget(appMount, mount)) continue;
    const source = mount.source;
    if (source === undefined) continue;
    const mountKey = `mount-${index}`;
    const session: FileSyncSessionSpec = {
      app,
      service: branded,
      mountKey,
      source: AbsolutePath.make(source),
      target: {
        _tag: "volume",
        name: fileSyncVolumeName(appName, serviceName, mountKey),
        path: mount.target,
      },
      mode: "two-way-safe",
      excludes: [],
    };
    entries.push({ engineId, session });
  }
  return entries;
};

const resolveFileSyncEngineId = (
  manifests: ReadonlyArray<{
    readonly contributes?:
      | { readonly fileSyncEngines?: ReadonlyArray<ContributionRef> | undefined }
      | undefined;
  }>,
): string | undefined => {
  for (const manifest of manifests) {
    const ids = (manifest.contributes?.fileSyncEngines ?? []).map(contributionId);
    if (ids.includes("mutagen")) return "mutagen";
  }
  for (const manifest of manifests) {
    const entry = (manifest.contributes?.fileSyncEngines ?? [])[0];
    if (entry !== undefined) return contributionId(entry);
  }
  return undefined;
};

const joinPathSegments = (target: string, exclude: string): string => {
  const normalizedTarget = target.endsWith("/") ? target.slice(0, -1) : target;
  const normalizedExclude = exclude.startsWith("/") ? exclude.slice(1) : exclude;
  return `${normalizedTarget}/${normalizedExclude}`;
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

type AuthoredStorageInfo = {
  readonly scope: StorageScope;
  readonly kind: "data" | "cache";
  readonly key?: string;
};

const cacheStorageKey = (target: string, key: string | undefined): string => key ?? kebab(target);

const cacheStoreName = (target: string, key: string | undefined): string =>
  `lando-cache-${cacheStorageKey(target, key)}`;

const authoredStorageScopes = (
  appRoot: string,
  serviceName: string,
  service: ServiceConfig,
): {
  byStore: Map<string, AuthoredStorageInfo>;
  globalEntry?: { index: number; store?: string };
  invalidCacheEntry?: LandofileValidationError;
} => {
  const byStore = new Map<string, AuthoredStorageInfo>();
  const entries = service.storage ?? [];
  for (const [index, entry] of entries.entries()) {
    if (typeof entry === "string") continue;
    if (entry.kind === "cache" && entry.scope === "service") {
      return {
        byStore,
        invalidCacheEntry: new LandofileValidationError({
          message: `Service ${serviceName} declares kind: cache with scope: service at services.${serviceName}.storage[${index}] in ${appRoot}/.lando.yml. Cache storage is shared across apps by design.`,
          file: `${appRoot}/.lando.yml`,
          issues: [`services.${serviceName}.storage[${index}].scope`],
        }),
      };
    }
    const kind = entry.kind ?? "data";
    const key = kind === "cache" ? cacheStorageKey(entry.target, entry.key) : entry.key;
    const storeName = kind === "cache" ? cacheStoreName(entry.target, entry.key) : entry.store;
    const scope = entry.scope ?? "service";
    if (scope === "global" && kind !== "cache") {
      return { byStore, globalEntry: { index, store: entry.store } };
    }
    byStore.set(storeName, {
      scope: kind === "cache" ? "global" : scope,
      kind,
      ...(key === undefined ? {} : { key }),
    });
  }
  return { byStore };
};

const storageMountTargetKey = (target: PortablePath): string => String(target);

const applyAuthoredStorage = (servicePlan: ServicePlan, service: ServiceConfig): ServicePlan => {
  const authored = service.storage ?? [];
  if (authored.length === 0) return servicePlan;
  const occupiedTargets = new Set(servicePlan.storage.map((mount) => storageMountTargetKey(mount.target)));
  const additions: DataStoreMountPlan[] = [];
  for (const entry of authored) {
    const target = typeof entry === "string" ? entry : entry.target;
    const mountTarget = PortablePath.make(target);
    const targetKey = storageMountTargetKey(mountTarget);
    if (occupiedTargets.has(targetKey)) continue;
    occupiedTargets.add(targetKey);
    const store =
      typeof entry === "string"
        ? kebab(target)
        : entry.kind === "cache"
          ? cacheStoreName(target, entry.key)
          : entry.store;
    additions.push({
      store,
      target: mountTarget,
      readOnly: typeof entry === "string" ? false : (entry.readOnly ?? false),
    });
  }
  if (additions.length === 0) return servicePlan;
  return { ...servicePlan, storage: [...servicePlan.storage, ...additions] };
};

const rejectGlobalScope = (
  appRoot: string,
  serviceName: string,
  entry: { index: number; store?: string },
): NotImplementedError =>
  new NotImplementedError({
    message: `Service ${serviceName} declares storage scope: global at services.${serviceName}.storage[${entry.index}]${entry.store ? ` (store ${entry.store})` : ""} in ${appRoot}/.lando.yml.`,
    commandId: "landofile.parse",
    remediation: GLOBAL_SCOPE_REMEDIATION,
  });

const expandExcludesToShadows = (
  appName: string,
  serviceName: string,
  servicePlan: ServicePlan,
): {
  servicePlan: ServicePlan;
  shadowStores: ReadonlyArray<{ name: string; scope: StorageScope }>;
} => {
  const appMount = servicePlan.appMount;
  if (appMount === undefined) return { servicePlan, shadowStores: [] };
  const excludes = appMount.excludes ?? [];
  const includes = new Set(appMount.includes ?? []);
  const effectiveExcludes = excludes.filter((entry) => !entry.startsWith("!") && !includes.has(entry));
  if (effectiveExcludes.length === 0) return { servicePlan, shadowStores: [] };

  const shadowStores: Array<{ name: string; scope: StorageScope }> = [];
  const shadowMounts: Array<{
    readonly store: string;
    readonly target: PortablePath;
    readonly readOnly: boolean;
  }> = [];

  for (const excludePath of effectiveExcludes) {
    const destination = joinPathSegments(appMount.target, excludePath);
    const storeName = `${appName}-${serviceName}-${kebab(destination)}-${shortHash(destination)}`;
    if (!shadowStores.some((entry) => entry.name === storeName)) {
      shadowStores.push({ name: storeName, scope: "service" });
    }
    shadowMounts.push({
      store: storeName,
      target: PortablePath.make(destination),
      readOnly: false,
    });
  }

  const nextPlan: ServicePlan = {
    ...servicePlan,
    storage: [...servicePlan.storage, ...shadowMounts],
  };

  return { servicePlan: nextPlan, shadowStores };
};

export const applyAuthoredAppMount = (servicePlan: ServicePlan, service: ServiceConfig): ServicePlan => {
  const authored = service.appMount;
  if (authored === undefined) return servicePlan;
  if (authored === false) return servicePlan;
  const existingMount = servicePlan.appMount;
  if (existingMount === undefined) return servicePlan;
  const merged = {
    ...existingMount,
    target: PortablePath.make(authored.target),
    readOnly: authored.readOnly ?? existingMount.readOnly,
    excludes:
      authored.excludes !== undefined
        ? [...existingMount.excludes, ...authored.excludes.filter((e) => !existingMount.excludes.includes(e))]
        : existingMount.excludes,
    includes: authored.includes ?? existingMount.includes,
  };
  return { ...servicePlan, appMount: merged };
};

export const applyAuthoredHealthcheck = (servicePlan: ServicePlan, service: ServiceConfig): ServicePlan => {
  const authored = service.healthcheck;
  if (authored === undefined) return servicePlan;
  const existing = servicePlan.healthcheck;
  const command = authored.command ?? existing?.command;
  const url = authored.url ?? existing?.url;
  const port = authored.port ?? existing?.port;
  const startPeriodSeconds = authored.startPeriodSeconds ?? existing?.startPeriodSeconds;
  const merged: ServicePlan["healthcheck"] = {
    kind: authored.kind ?? existing?.kind ?? "command",
    intervalSeconds: authored.intervalSeconds ?? existing?.intervalSeconds ?? 10,
    timeoutSeconds: authored.timeoutSeconds ?? existing?.timeoutSeconds ?? 5,
    retries: authored.retries ?? existing?.retries ?? 5,
    ...(command !== undefined ? { command } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(startPeriodSeconds !== undefined ? { startPeriodSeconds } : {}),
  };
  if (merged.kind === "command" && merged.command === undefined) {
    return servicePlan;
  }
  return { ...servicePlan, healthcheck: merged };
};

interface ResolvedService {
  readonly name: string;
  readonly service: ServiceConfig;
  readonly authored: ReturnType<typeof authoredStorageScopes>;
  readonly serviceType: ServiceType;
  readonly resolution: ServiceTypeResolution;
  readonly logSources: ReadonlyArray<LogSource>;
  readonly baseDefaultIds: ReadonlyArray<string>;
  readonly featureRefs: ReadonlyArray<{ readonly id: string; readonly config?: unknown }>;
  readonly resolvedArtifactTag: string | undefined;
}

type PlannedServiceDraft = {
  readonly name: string;
  readonly hostnames: ReadonlyArray<string>;
  readonly authored: ReturnType<typeof authoredStorageScopes>;
  readonly draft: AppFeatureServiceDraft;
  readonly logSources: ReadonlyArray<LogSource>;
  readonly routes: ServicePlan["routes"];
  readonly extensions: ServicePlan["extensions"];
};

const SERVICE_FEATURES_EXTENSION_KEY = "@lando/core/service-features";
const LOG_SOURCES_EXTENSION_KEY = "@lando/core/log-sources";

const baseDefaultFeatureIds = (base: ServiceTypeResolution["base"]): ReadonlyArray<string> =>
  base === "lando" ? LANDO_BASE_DEFAULT_FEATURE_IDS : L337_BASE_DEFAULT_FEATURE_IDS;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const serviceFeatureExtension = (
  extensions: ServicePlan["extensions"],
): Record<string, unknown> | undefined => {
  const extension = extensions[SERVICE_FEATURES_EXTENSION_KEY];
  return isRecord(extension) ? extension : undefined;
};

const serviceFeatureBuildSteps = (extensions: ServicePlan["extensions"]): ServiceBuildStepIntent[] => {
  const buildSteps = serviceFeatureExtension(extensions)?.buildSteps;
  return Array.isArray(buildSteps) ? buildSteps.map((step) => ({ ...(step as ServiceBuildStepIntent) })) : [];
};

const draftFeatureIds = (draft: DraftServicePlan): ReadonlyArray<string> => {
  if (!("featureIds" in draft)) return [];
  const { featureIds } = draft;
  return Array.isArray(featureIds) ? featureIds.filter((id): id is string => typeof id === "string") : [];
};

const toAppFeatureDraft = (
  name: string,
  servicePlan: ServicePlan,
  serviceResolution: ServiceTypeResolution,
  baseDefaultIds: ReadonlyArray<string>,
): AppFeatureServiceDraft => ({
  name: servicePlan.name,
  serviceName: name,
  type: servicePlan.type,
  serviceType: servicePlan.type,
  provider: servicePlan.provider,
  primary: servicePlan.primary,
  base: serviceResolution.base,
  framework: serviceResolution.normalizedConfig.framework,
  featureIds: [...baseDefaultIds, ...serviceResolution.features.map((feature) => feature.id)],
  normalizedConfig: serviceResolution.normalizedConfig,
  ...(servicePlan.artifact === undefined ? {} : { artifact: servicePlan.artifact }),
  ...(servicePlan.command === undefined ? {} : { command: servicePlan.command }),
  ...(servicePlan.entrypoint === undefined ? {} : { entrypoint: servicePlan.entrypoint }),
  environment: { ...servicePlan.environment },
  ...(servicePlan.user === undefined ? {} : { user: servicePlan.user }),
  ...(servicePlan.workingDirectory === undefined ? {} : { workingDirectory: servicePlan.workingDirectory }),
  ...(servicePlan.appMount === undefined
    ? {}
    : {
        appMount: {
          source: servicePlan.appMount.source,
          target: servicePlan.appMount.target,
          readOnly: servicePlan.appMount.readOnly,
          excludes: servicePlan.appMount.excludes,
          includes: servicePlan.appMount.includes,
        },
      }),
  mounts: servicePlan.mounts.map((mount) => {
    const { realization: _realization, ...intent } = mount;
    return intent;
  }),
  buildSteps: serviceFeatureBuildSteps(servicePlan.extensions),
  storage: servicePlan.storage.map((storage) => ({ ...storage })),
  endpoints: servicePlan.endpoints.map((endpoint) => ({ ...endpoint })),
  dependsOn: servicePlan.dependsOn.map((dependency) => ({ ...dependency })),
  ...(servicePlan.healthcheck === undefined ? {} : { healthcheck: servicePlan.healthcheck }),
  ...(servicePlan.certs === undefined ? {} : { certs: servicePlan.certs }),
  hostAliases: servicePlan.hostAliases.map((alias) => ({ ...alias })),
});

const servicePlanFromDraft = (
  draft: DraftServicePlan,
  routes: ServicePlan["routes"],
  metadata: ServicePlan["metadata"],
  extensions: ServicePlan["extensions"],
): ServicePlan => ({
  name: draft.name,
  type: draft.type,
  provider: draft.provider,
  primary: draft.primary,
  ...(draft.artifact === undefined ? {} : { artifact: draft.artifact }),
  ...(draft.command === undefined ? {} : { command: draft.command }),
  ...(draft.entrypoint === undefined ? {} : { entrypoint: draft.entrypoint }),
  environment: sortRecord(draft.environment),
  ...(draft.user === undefined ? {} : { user: draft.user }),
  ...(draft.workingDirectory === undefined ? {} : { workingDirectory: draft.workingDirectory }),
  ...(draft.appMount === undefined ? {} : { appMount: { ...draft.appMount, realization: "passthrough" } }),
  mounts: draft.mounts.map((mount) => ({ ...mount, realization: "passthrough" })),
  storage: draft.storage.map((storage) => ({ ...storage })),
  endpoints: draft.endpoints.map((endpoint) => ({ ...endpoint })),
  routes: routes.map((route) => ({ ...route })),
  dependsOn: draft.dependsOn.map((dependency) => ({ ...dependency })),
  ...(draft.healthcheck === undefined ? {} : { healthcheck: draft.healthcheck }),
  ...(draft.certs === undefined ? {} : { certs: draft.certs }),
  hostAliases: draft.hostAliases.map((alias) => ({ ...alias })),
  metadata,
  extensions: servicePlanExtensionsFromDraft(draft, extensions),
});

const servicePlanExtensionsFromDraft = (
  draft: DraftServicePlan,
  extensions: ServicePlan["extensions"],
): ServicePlan["extensions"] => {
  const featureIds = draftFeatureIds(draft);
  if (draft.buildSteps.length === 0 && featureIds.length === 0) return extensions;
  return {
    ...extensions,
    [SERVICE_FEATURES_EXTENSION_KEY]: {
      ...serviceFeatureExtension(extensions),
      ...(featureIds.length === 0 ? {} : { featureIds: [...featureIds] }),
      buildSteps: draft.buildSteps.map((step) => ({ ...step })),
    },
  };
};

const resolveHostFacts = (): ServiceTypeHostFacts | undefined => {
  try {
    const userInfo = os.userInfo();
    return {
      os: process.platform,
      user: userInfo.username,
      uid: String(userInfo.uid),
      gid: String(userInfo.gid),
      home: userInfo.homedir,
    };
  } catch {
    return undefined;
  }
};

const planApp = (
  pluginRegistry: Context.Tag.Service<typeof PluginRegistry>,
  cacheService: Context.Tag.Service<typeof CacheService> | undefined,
  configService: Context.Tag.Service<typeof ConfigService> | undefined,
  landofile: LandofileShape,
  providerCapabilities: ProviderCapabilities,
  options: AppPlannerOptions,
): Effect.Effect<AppPlan, LandofileValidationError | CapabilityError | NotImplementedError> => {
  const appRoot = process.cwd();
  const appName = landofile.name ?? "app";
  const appId = AppId.make(appName);
  const host = resolveHostFacts();
  const resolvedAt = new Date().toISOString();
  const encodedMetadata = {
    resolvedAt,
    source: `${appRoot}/.lando.yml`,
    runtime: 4 as const,
  };
  const metadata: ServicePlan["metadata"] = {
    resolvedAt: DateTime.unsafeMake(resolvedAt),
    source: `${appRoot}/.lando.yml`,
    runtime: 4 as const,
  };
  const services: Record<string, unknown> = {};
  const serviceHostnames: Record<string, ReadonlyArray<string>> = {};
  const aggregatedStores: Array<{
    name: string;
    scope: StorageScope;
    kind?: "data" | "cache";
    key?: string;
  }> = [];
  const fileSyncEntries: Array<FileSyncPlan> = [];
  const aggregatedRoutes: Array<RoutePlan> = [];
  const seenStoreNames = new Set<string>();

  const pushStore = (
    name: string,
    scope: StorageScope,
    kind: "data" | "cache" = "data",
    key?: string,
  ): void => {
    if (seenStoreNames.has(name)) return;
    seenStoreNames.add(name);
    aggregatedStores.push({ name, scope, kind, ...(key === undefined ? {} : { key }) });
  };

  return Effect.gen(function* () {
    const configProvider =
      configService === undefined
        ? undefined
        : yield* configService
            .get("defaultProviderId")
            .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
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
            file: `${appRoot}/.lando.yml`,
            issues: [],
          }),
      ),
    );
    const fileSyncEngineId =
      providerCapabilities.bindMountPerformance === "slow" ? resolveFileSyncEngineId(manifests) : undefined;
    const cacheRoot = resolveUserCacheRoot();
    const sourceFingerprint = yield* readAppPlanSourceFingerprint(appRoot).pipe(
      Effect.catchAll(() => Effect.succeed(undefined)),
    );
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
              file: `${appRoot}/.lando.yml`,
              issues: [`plugins.${ref.pluginId}.appFeatures.${ref.id}`],
            }),
        ),
      );
      appFeatures.push({ id: ref.id, definition, pluginId: ref.pluginId });
    }

    // Phase A: resolve every service type once (cheap, no plan production) so
    // the cache key can fold in the resolved base + ordered FeatureRef list
    // before the expensive composition runs. The resolution objects are reused
    // verbatim in phase B on a cache miss; resolve() is never called twice.
    const resolvedServices: ResolvedService[] = [];
    for (const [name, service] of Object.entries(landofile.services ?? {})) {
      const authored = authoredStorageScopes(appRoot, name, service);
      if (authored.invalidCacheEntry !== undefined) {
        yield* Effect.fail(authored.invalidCacheEntry);
      }
      if (authored.globalEntry !== undefined) {
        yield* Effect.fail(rejectGlobalScope(appRoot, name, authored.globalEntry));
      }

      const serviceTypeId = serviceTypeFor(name, service);
      const { serviceType, version } = yield* loadServiceTypeWithVersion(pluginRegistry, serviceTypeId).pipe(
        Effect.mapError((error) =>
          error instanceof ServiceTypeCollisionError
            ? serviceTypeCollision(appRoot, name, error)
            : unsupportedServiceType(appRoot, name, serviceTypeId, registeredServiceTypeIds),
        ),
      );

      const resolvedArtifactTag = yield* resolvePinnedArtifactTag(appRoot, name, serviceType, version);
      // Pinned artifact tag becomes the service image so it flows into both
      // the cache key (which folds normalizedConfig) and the legacy plan body
      // (which reads service.image). The original authored image wins only when
      // no version pin was requested.
      const pinnedService: ServiceConfig =
        resolvedArtifactTag === undefined ? service : { ...service, image: resolvedArtifactTag };

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
        })
        .pipe(Effect.mapError((error) => servicePlanError(appRoot, name, error)));

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
      // The base's default feature stack seeds the draft alongside the
      // resolution's explicit features; an id the resolution already lists
      // wins, so the base default is not loaded twice. The cache fingerprint
      // records base defaults first, then resolution features, in that order.
      const baseDefaultIds = baseDefaultFeatureIds(resolution.base).filter(
        (id) => !resolutionFeatureIds.has(id),
      );
      const featureRefs: ReadonlyArray<{ readonly id: string; readonly config?: unknown }> = [
        ...baseDefaultIds.map((id) => ({ id })),
        ...resolution.features.map((featureRef) => ({
          id: featureRef.id,
          ...(featureRef.config === undefined ? {} : { config: featureRef.config }),
        })),
      ];

      resolvedServices.push({
        name,
        service: pinnedService,
        authored,
        serviceType,
        resolution,
        logSources,
        baseDefaultIds,
        featureRefs,
        resolvedArtifactTag,
      });
    }

    // The cache key folds in the resolved base, the ordered FeatureRef list, and
    // the app-feature DEFINITION inputs (a deterministic function of which app
    // features activate over the resolved drafts). It is derived BEFORE plan
    // production so a warm cache still skips composition; a feature/base change
    // rolls the key even when the Landofile bytes are identical.
    const versionConstraints = getVersionConstraintEntries(landofile, `${appRoot}/.lando.yml`);
    const cacheKey = deriveAppPlanCacheKey({
      appRoot,
      landofile: { ...landofile, provider },
      providerCapabilities,
      ...(options.routeAuthorityPorts === undefined
        ? {}
        : { routeAuthorityPorts: options.routeAuthorityPorts }),
      pluginManifests: manifests,
      ...(sourceFingerprint === undefined ? {} : { sourceFingerprint }),
      versionConstraints,
      serviceInputs: {
        landofile: landofile.services ?? {},
        composition: {
          services: resolvedServices.map((entry) => ({
            name: entry.name,
            serviceType: entry.serviceType.id,
            base: entry.resolution.base,
            normalizedConfig: entry.resolution.normalizedConfig,
            logSources: entry.logSources,
            featureRefs: entry.featureRefs,
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
      const cached = yield* readCachedAppPlan({ cacheRoot, appName, appRoot, key: cacheKey }).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      );
      if (cached !== null) return cached;
    }

    // Phase B (cache miss only): produce the per-service plans from the reused
    // resolutions, then run the app-feature pass and finalization.
    const plannedServiceDrafts: PlannedServiceDraft[] = [];
    for (const {
      name,
      service,
      authored,
      serviceType,
      resolution,
      logSources,
      baseDefaultIds,
    } of resolvedServices) {
      const rawPlan = yield* Effect.gen(function* () {
        const features = yield* Effect.forEach(resolution.features, (featureRef) =>
          pluginRegistry.loadServiceFeature(featureRef.id).pipe(
            Effect.map(
              (definition): ComposeServiceFeature => ({
                id: featureRef.id,
                ...(featureRef.config === undefined ? {} : { config: featureRef.config }),
                definition,
              }),
            ),
            Effect.mapError((error) => servicePlanError(appRoot, name, error)),
          ),
        );
        const defaultFeatures = yield* Effect.forEach(baseDefaultIds, (id) =>
          pluginRegistry
            .loadServiceFeature(id)
            .pipe(Effect.mapError((error) => servicePlanError(appRoot, name, error))),
        );
        return yield* composeService({
          base: {
            name: ServiceName.make(name),
            // Versioned service-type ids (e.g. `elasticsearch:8`) resolve to a
            // canonical plan type (`elasticsearch`); honor the resolution's
            // normalized type, falling back to the registered id.
            type: resolution.normalizedConfig.type ?? serviceType.id,
            provider,
            primary: resolution.normalizedConfig.primary ?? name === "web",
            ...(resolution.normalizedConfig.environment === undefined
              ? {}
              : { environment: resolution.normalizedConfig.environment }),
            defaultFeatures,
          },
          baseKind: resolution.base,
          appName,
          appRoot,
          host,
          normalizedConfig: resolution.normalizedConfig,
          features,
        }).pipe(Effect.mapError((error) => servicePlanError(appRoot, name, error)));
      });
      const authoredServicePlan = applyAuthoredStorage(
        applyAuthoredHealthcheck(applyAuthoredAppMount(mergeDefaultExcludes(rawPlan), service), service),
        service,
      );
      const authoredAppBuild = service.build?.app;
      const appBuildScripts =
        authoredAppBuild === undefined
          ? []
          : Array.isArray(authoredAppBuild)
            ? authoredAppBuild
            : [authoredAppBuild];
      const servicePlan: ServicePlan =
        appBuildScripts.length === 0
          ? authoredServicePlan
          : {
              ...authoredServicePlan,
              extensions: {
                ...authoredServicePlan.extensions,
                [SERVICE_FEATURES_EXTENSION_KEY]: {
                  ...serviceFeatureExtension(authoredServicePlan.extensions),
                  buildSteps: [
                    ...serviceFeatureBuildSteps(authoredServicePlan.extensions),
                    ...appBuildScripts.map((script, index) => ({
                      id: `authored-app:${index + 1}`,
                      phase: "app",
                      command: { command: ["sh", "-lc", script] },
                    })),
                  ],
                },
              },
            };
      plannedServiceDrafts.push({
        name,
        hostnames: service.hostnames ?? [],
        authored,
        draft: toAppFeatureDraft(name, servicePlan, resolution, baseDefaultIds),
        logSources,
        routes: servicePlan.routes,
        extensions: servicePlan.extensions,
      });
    }

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

    for (const { name, hostnames, authored, draft, logSources, routes, extensions } of plannedServiceDrafts) {
      const followLogSources = runtimeFollowLogSources(logSources);
      const providerSupportsLogSources = providerCapabilities.serviceLogSources === true;
      if (!providerSupportsLogSources) {
        const requiredFollowSource = followLogSources.find((source) => source.required === true);
        if (requiredFollowSource !== undefined) {
          yield* Effect.fail(
            missingCapability(
              provider,
              name,
              `required follow log source ${String(requiredFollowSource.id)}`,
              "serviceLogSources",
              `Use strategy: redirect for service ${name} log source ${String(requiredFollowSource.id)}, or choose a provider that advertises serviceLogSources.`,
            ),
          );
        }
      }

      const unavailableFollowSources = providerSupportsLogSources
        ? []
        : followLogSources.filter((source) => source.required !== true);
      const extensionsForPlan: ServicePlan["extensions"] =
        unavailableFollowSources.length === 0
          ? extensions
          : {
              ...extensions,
              [LOG_SOURCES_EXTENSION_KEY]: {
                ...(isRecord(extensions[LOG_SOURCES_EXTENSION_KEY])
                  ? extensions[LOG_SOURCES_EXTENSION_KEY]
                  : {}),
                unavailableFollow: unavailableFollowSources.map((source) => ({
                  id: String(source.id),
                  path: String(source.path),
                  reason:
                    "Provider does not advertise serviceLogSources; use strategy: redirect or choose a provider with serviceLogSources.",
                })),
              },
            };
      const redirectSteps = redirectLogSourceBuildSteps({ logSources, base: draft.base });
      const draftForPlan =
        redirectSteps.length === 0
          ? draft
          : { ...draft, buildSteps: [...draft.buildSteps, ...redirectSteps] };
      const servicePlan = {
        ...servicePlanFromDraft(draftForPlan, routes, metadata, extensionsForPlan),
        ...(logSources.length === 0 ? {} : { logSources }),
      };

      if (
        (servicePlan.appMount !== undefined || servicePlan.mounts.some((mount) => mount.type === "bind")) &&
        (!providerCapabilities.bindMounts || providerCapabilities.bindMountPerformance === "none")
      ) {
        yield* Effect.fail(
          missingCapability(provider, name, "bind mount", "bindMounts", serviceBindRemediation(name)),
        );
      }

      if (servicePlan.artifact?.kind === "build" && !providerCapabilities.artifactBuild) {
        yield* Effect.fail(
          missingCapability(
            provider,
            name,
            "artifact build",
            "artifactBuild",
            serviceArtifactBuildRemediation(name),
          ),
        );
      }

      const realization = bindRealization(providerCapabilities);
      const shadowResult = expandExcludesToShadows(appName, name, servicePlan);
      const planWithShadows = shadowResult.servicePlan;

      const appMount = planWithShadows.appMount;
      const servicePlanWithCapabilityRealization: ServicePlan = {
        ...planWithShadows,
        ...(appMount === undefined ? {} : { appMount: { ...appMount, realization } }),
        mounts: planWithShadows.mounts.map((mount) =>
          mount.type === "bind" ? { ...mount, realization } : mount,
        ),
      };

      if (
        servicePlanWithCapabilityRealization.endpoints.some(isHostPublishedEndpoint) &&
        providerCapabilities.hostPortPublish === "none"
      ) {
        yield* Effect.fail(
          missingCapability(
            provider,
            name,
            "host port publish",
            "hostPortPublish",
            `Choose a provider with host port publish support or remove published ports from service ${name}.`,
          ),
        );
      }

      if (
        servicePlanWithCapabilityRealization.storage.length > 0 &&
        !providerCapabilities.persistentStorage
      ) {
        yield* Effect.fail(
          missingCapability(
            provider,
            name,
            "persistent storage",
            "persistentStorage",
            `Choose a provider with persistent storage support or remove persistent storage from service ${name}.`,
          ),
        );
      }

      const healthcheck = servicePlanWithCapabilityRealization.healthcheck;
      if (healthcheck !== undefined && healthcheck.kind !== "command" && healthcheck.kind !== "none") {
        yield* Effect.fail(
          missingCapability(
            provider,
            name,
            `healthcheck kind ${healthcheck.kind}`,
            "serviceHealth",
            `Healthcheck for service ${name} uses kind: ${healthcheck.kind}, but only kind: command is supported (executed via the provider's exec channel). Author healthcheck as kind: command or remove it.`,
          ),
        );
      }

      serviceHostnames[name] = hostnames;
      services[name] = Schema.encodeSync(ServicePlan)(servicePlanWithCapabilityRealization);

      for (const shadow of shadowResult.shadowStores) {
        pushStore(shadow.name, shadow.scope);
      }

      for (const mount of servicePlanWithCapabilityRealization.storage) {
        const authoredInfo = authored.byStore.get(mount.store);
        pushStore(
          mount.store,
          authoredInfo?.scope ?? "service",
          authoredInfo?.kind ?? "data",
          authoredInfo?.key,
        );
      }

      if (fileSyncEngineId !== undefined) {
        fileSyncEntries.push(
          ...collectFileSyncEntries({
            appId,
            appRoot,
            appName,
            serviceName: name,
            servicePlan: servicePlanWithCapabilityRealization,
            engineId: fileSyncEngineId,
          }),
        );
      }

      for (const ep of servicePlanWithCapabilityRealization.endpoints) {
        if (ep.protocol !== "http" && ep.protocol !== "https") continue;
        const endpointRef: string | number | undefined = ep.name !== undefined ? ep.name : ep.port;
        aggregatedRoutes.push({
          hostname: `${name}.${appName}.${DEFAULT_PROXY_DOMAIN}`,
          scheme: "https",
          service: ServiceName.make(name),
          ...(endpointRef !== undefined ? { endpoint: endpointRef } : {}),
          ...(options.routeAuthorityPorts === undefined
            ? {}
            : { authorityPorts: options.routeAuthorityPorts }),
        });
      }
    }

    const serviceNames = Object.keys(services);
    const hasServices = serviceNames.length > 0;
    const networks: ReadonlyArray<NetworkPlan> = hasServices
      ? [
          {
            name: appNetworkName(appName),
            shared: false,
            driver: "bridge",
          },
        ]
      : [];
    const networking: NetworkingPlan | undefined = hasServices
      ? landoNetworkingPlan({
          slug: appName,
          serviceNames,
          sharedCrossAppNetwork: providerCapabilities.sharedCrossAppNetwork,
          serviceHostnames,
        })
      : undefined;

    const hostProxyExtension = hostProxyExtensionForCapabilities(providerCapabilities);
    const plan = yield* decodeAppPlan(appRoot, {
      id: appId,
      name: appName,
      slug: appName,
      root: AbsolutePath.make(appRoot),
      provider,
      services,
      routes: aggregatedRoutes,
      networks,
      ...(networking !== undefined ? { networking } : {}),
      stores: aggregatedStores,
      fileSync: fileSyncEntries,
      metadata: encodedMetadata,
      extensions:
        hostProxyExtension === undefined ? {} : { [HOST_PROXY_PLAN_EXTENSION_KEY]: hostProxyExtension },
      ...(() => {
        const requiredGlobalServices = [
          ...(aggregatedRoutes.length > 0 ? ["traefik"] : []),
          ...appFeatureResult.requires.globalServices,
        ];
        return requiredGlobalServices.length === 0
          ? {}
          : { requires: { globalServices: [...new Set(requiredGlobalServices)] } };
      })(),
    });
    if (
      cacheService !== undefined &&
      !hasSkippedUnsatisfiedVersionConstraint(versionConstraints, CORE_VERSION)
    ) {
      yield* writeCachedAppPlan({
        cacheRoot,
        appName,
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

export const AppPlannerLive = Layer.effect(
  AppPlanner,
  Effect.gen(function* () {
    const pluginRegistry = yield* PluginRegistry;
    const cacheService = yield* Effect.serviceOption(CacheService);
    const configService = yield* Effect.serviceOption(ConfigService);
    return {
      plan: (landofile, providerCapabilities, options) =>
        planApp(
          pluginRegistry,
          cacheService._tag === "Some" ? cacheService.value : undefined,
          configService._tag === "Some" ? configService.value : undefined,
          landofile,
          providerCapabilities,
          options,
        ),
    } satisfies Context.Tag.Service<typeof AppPlanner>;
  }),
);
