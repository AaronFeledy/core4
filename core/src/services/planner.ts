import { createHash } from "node:crypto";
import * as os from "node:os";

import { type Context, Effect, Either, Layer, ParseResult, Schema } from "effect";

import { CapabilityError, LandofileValidationError, NotImplementedError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  AppPlan,
  type LandofileShape,
  type NetworkPlan,
  PortablePath,
  type ProviderCapabilities,
  type ProviderId,
  type ServiceConfig,
  ServicePlan,
  type StorageScope,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  CacheService,
  ConfigService,
  PluginRegistry,
  type ServiceTypeHostFacts,
} from "@lando/sdk/services";

import {
  CAPABILITY_DEFAULT_PROVIDER_ID,
  readProviderEnvVar,
  resolveProviderSelection,
} from "../providers/precedence.ts";

import { deriveAppPlanCacheKey, readCachedAppPlan, writeCachedAppPlan } from "../cache/app-plan.ts";
import { resolveUserCacheRoot } from "../cache/paths.ts";

export { AppPlanner } from "@lando/sdk/services";

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

const bindRealization = (providerCapabilities: ProviderCapabilities) =>
  providerCapabilities.bindMountPerformance === "slow" ? "accelerated" : "passthrough";

const kebab = (raw: string): string => {
  const ascii = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii.length === 0 ? "shadow" : ascii;
};

const shortHash = (input: string): string => createHash("sha256").update(input).digest("hex").slice(0, 8);

const appNetworkName = (slug: string): string => `lando-${slug}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

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
};

const authoredStorageScopes = (
  service: ServiceConfig,
): { byStore: Map<string, AuthoredStorageInfo>; globalEntry?: { index: number; store?: string } } => {
  const byStore = new Map<string, AuthoredStorageInfo>();
  const entries = service.storage ?? [];
  for (const [index, entry] of entries.entries()) {
    if (typeof entry === "string") continue;
    const scope = entry.scope ?? "service";
    if (scope === "global") {
      return { byStore, globalEntry: { index, store: entry.store } };
    }
    byStore.set(entry.store, { scope });
  }
  return { byStore };
};

const rejectGlobalScope = (
  appRoot: string,
  serviceName: string,
  entry: { index: number; store?: string },
): NotImplementedError =>
  new NotImplementedError({
    message: `Service ${serviceName} declares storage scope: global at services.${serviceName}.storage[${entry.index}]${entry.store ? ` (store ${entry.store})` : ""} in ${appRoot}/.lando.yml.`,
    commandId: "landofile.parse",
    specSection: "§6.5",
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

const applyAuthoredAppMount = (servicePlan: ServicePlan, service: ServiceConfig): ServicePlan => {
  const authored = service.appMount;
  if (authored === undefined) return servicePlan;
  if (authored === false) return servicePlan;
  if (servicePlan.appMount === undefined) return servicePlan;
  const merged = {
    ...servicePlan.appMount,
    target: PortablePath.make(authored.target),
    readOnly: authored.readOnly ?? servicePlan.appMount.readOnly,
    excludes: authored.excludes ?? servicePlan.appMount.excludes,
    includes: authored.includes ?? servicePlan.appMount.includes,
  };
  return { ...servicePlan, appMount: merged };
};

const applyAuthoredHealthcheck = (servicePlan: ServicePlan, service: ServiceConfig): ServicePlan => {
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
): Effect.Effect<AppPlan, LandofileValidationError | CapabilityError | NotImplementedError> => {
  const appRoot = process.cwd();
  const appName = landofile.name ?? "app";
  const appId = AppId.make(appName);
  const host = resolveHostFacts();
  const metadata = {
    resolvedAt: new Date().toISOString(),
    source: `${appRoot}/.lando.yml`,
    runtime: 4 as const,
  };
  const services: Record<string, unknown> = {};
  const aggregatedStores: Array<{ name: string; scope: StorageScope }> = [];
  const seenStoreNames = new Set<string>();

  const pushStore = (name: string, scope: StorageScope): void => {
    if (seenStoreNames.has(name)) return;
    seenStoreNames.add(name);
    aggregatedStores.push({ name, scope });
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
    const cacheRoot = resolveUserCacheRoot();
    const cacheKey = deriveAppPlanCacheKey({
      appRoot,
      landofile: { ...landofile, provider },
      providerCapabilities,
      pluginManifests: manifests,
    });
    if (cacheService !== undefined) {
      const cached = yield* readCachedAppPlan({ cacheRoot, appName, appRoot, key: cacheKey }).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      );
      if (cached !== null) return cached;
    }
    const registeredServiceTypeIds = manifests.flatMap(
      (manifest) => manifest.contributes?.serviceTypes ?? [],
    );

    for (const [name, service] of Object.entries(landofile.services ?? {})) {
      const authored = authoredStorageScopes(service);
      if (authored.globalEntry !== undefined) {
        yield* Effect.fail(rejectGlobalScope(appRoot, name, authored.globalEntry));
      }

      const serviceTypeId = serviceTypeFor(name, service);
      const serviceType = yield* pluginRegistry
        .loadServiceType(serviceTypeId)
        .pipe(
          Effect.mapError(() =>
            unsupportedServiceType(appRoot, name, serviceTypeId, registeredServiceTypeIds),
          ),
        );

      const rawPlan = yield* Effect.try({
        try: () =>
          serviceType.toServicePlan({
            name,
            service,
            appRoot,
            appName,
            provider,
            primary: name === "web",
            metadata,
            host,
          }),
        catch: (cause) => servicePlanError(appRoot, name, cause),
      });
      const servicePlan = applyAuthoredHealthcheck(applyAuthoredAppMount(rawPlan, service), service);

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
        servicePlanWithCapabilityRealization.endpoints.some((endpoint) => endpoint.port !== undefined) &&
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
            `Healthcheck for service ${name} uses kind: ${healthcheck.kind}, but Alpha only supports kind: command (executed via the provider's exec channel). Author healthcheck as kind: command or remove it.`,
          ),
        );
      }

      services[name] = Schema.encodeSync(ServicePlan)(servicePlanWithCapabilityRealization);

      for (const shadow of shadowResult.shadowStores) {
        pushStore(shadow.name, shadow.scope);
      }

      for (const mount of servicePlanWithCapabilityRealization.storage) {
        const authoredInfo = authored.byStore.get(mount.store);
        pushStore(mount.store, authoredInfo?.scope ?? "service");
      }
    }

    const networks: ReadonlyArray<NetworkPlan> =
      Object.keys(services).length === 0
        ? []
        : [
            {
              name: appNetworkName(appName),
              shared: false,
              driver: "bridge",
            },
          ];

    const plan = yield* decodeAppPlan(appRoot, {
      id: appId,
      name: appName,
      slug: appName,
      root: AbsolutePath.make(appRoot),
      provider,
      services,
      routes: [],
      networks,
      stores: aggregatedStores,
      metadata,
      extensions: {},
    });
    if (cacheService !== undefined) {
      yield* writeCachedAppPlan({ cacheRoot, appName, appRoot, key: cacheKey, plan }).pipe(
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
      plan: (landofile, providerCapabilities) =>
        planApp(
          pluginRegistry,
          cacheService._tag === "Some" ? cacheService.value : undefined,
          configService._tag === "Some" ? configService.value : undefined,
          landofile,
          providerCapabilities,
        ),
    } satisfies Context.Tag.Service<typeof AppPlanner>;
  }),
);
