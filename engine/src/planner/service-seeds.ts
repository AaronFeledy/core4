import { LandofileValidationError, ServiceTypeCollisionError } from "@lando/sdk/errors";
import type { LandofileShape, ProviderCapabilities, ServiceConfig, ServiceCreds } from "@lando/sdk/schema";
import { ServiceName, validationIssue } from "@lando/sdk/schema";
import type { FileSystem, PluginRegistry, ServiceTypeInput } from "@lando/sdk/services";
import { type Context, Effect, Result } from "effect";
import { isComposeBuild } from "../services/compose-build-artifact.ts";
import { type UserAppDefaults, withUserAppDefaults } from "./app-defaults.ts";
import { loadServiceEnvFiles, loadTopLevelEnvFiles } from "./env-files.ts";
import {
  type DeferredExpressionSites,
  type ServiceCredsScope,
  materializeServiceScopeSites,
  orderServicesByCredsReferences,
  serviceCredsScopeEntry,
  serviceScopeContext,
} from "./landofile-scopes.ts";
import { loadAuthorizedServiceProjectFiles } from "./node-authoring.ts";
import {
  loadServiceTypeWithVersion,
  resolvePinnedArtifactTag,
  servicePlanError,
  serviceTypeCollision,
  serviceTypeFor,
  unsupportedServiceType,
} from "./service-types.ts";
import { authoredStorageScopes, rejectGlobalScope } from "./storage.ts";

export interface ServiceSeedInput {
  readonly landofile: LandofileShape;
  readonly landofilePath: string;
  readonly appSlug: string;
  readonly defaultDomain: string;
  /** Value sites the identity pass left for the service scope (see landofile-scopes.ts). */
  readonly deferredSites: DeferredExpressionSites;
  readonly pluginRegistry: Context.Service.Shape<typeof PluginRegistry>;
  readonly fileSystem: Context.Service.Shape<typeof FileSystem> | undefined;
  readonly appRoot: string;
  readonly appName: string;
  readonly appDefaults: UserAppDefaults;
  readonly registeredServiceTypeIds: ReadonlyArray<string>;
  readonly metadata: ServiceTypeInput["metadata"];
  readonly host: ServiceTypeInput["host"];
  readonly provider: ServiceTypeInput["provider"];
  readonly capabilities?: ProviderCapabilities;
}

type TopLevelEnvFiles = Effect.Success<ReturnType<typeof loadTopLevelEnvFiles>>;

const resolveSeed = Effect.fnUntraced(function* (
  input: ServiceSeedInput,
  topLevelEnvFiles: TopLevelEnvFiles,
  name: string,
  service: ServiceConfig,
) {
  const { pluginRegistry, fileSystem, appRoot, appName, appDefaults, registeredServiceTypeIds } = input;
  const loadedEnvFiles = yield* loadServiceEnvFiles({
    appRoot,
    serviceName: name,
    service,
    fileSystem,
  });
  const serviceWithEnvironment = withUserAppDefaults({
    service,
    defaults: appDefaults,
    topLevelEnvironment: topLevelEnvFiles.environment,
    serviceEnvironment: loadedEnvFiles.environment,
    hasEnvFiles: topLevelEnvFiles.inputs.length > 0 || loadedEnvFiles.inputs.length > 0,
  });
  if (
    serviceWithEnvironment.image !== undefined &&
    serviceWithEnvironment.build !== undefined &&
    isComposeBuild(serviceWithEnvironment.build)
  ) {
    return yield* Effect.fail(
      new LandofileValidationError({
        message: `Service ${name} must declare exactly one of image or a Compose build, not both. Remove image or replace build with a Lando build-script block.`,
        file: `${appRoot}/.lando.yml`,
        issues: [
          validationIssue(
            ["services", name, "build"],
            `Service ${name} must declare exactly one of image or a Compose build, not both. Remove image or replace build with a Lando build-script block.`,
          ),
        ],
      }),
    );
  }
  const authored = authoredStorageScopes(appRoot, name, serviceWithEnvironment);
  if (authored.invalidCacheEntry !== undefined) yield* Effect.fail(authored.invalidCacheEntry);
  if (authored.globalEntry !== undefined)
    yield* Effect.fail(rejectGlobalScope(appRoot, name, authored.globalEntry));
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
    resolvedArtifactTag === undefined || serviceWithEnvironment.image !== undefined
      ? serviceWithEnvironment
      : { ...serviceWithEnvironment, image: resolvedArtifactTag };
  const projectFiles = yield* loadAuthorizedServiceProjectFiles({
    appRoot,
    name,
    service,
    serviceType,
    serviceTypeId,
    version,
    pinnedService,
    registeredServiceTypeIds,
    fileSystem,
  });
  const resolution = yield* serviceType
    .resolve({
      name,
      service: pinnedService,
      appRoot,
      appName,
      primary: name === "web",
      metadata: input.metadata,
      ...(input.host === undefined ? {} : { host: input.host }),
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
      projectFiles,
    })
    .pipe(Effect.mapError((error) => servicePlanError(appRoot, name, error)));
  return {
    name,
    authoredService: service,
    service: pinnedService,
    authored,
    serviceType,
    resolution,
    resolvedArtifactTag,
    projectFiles,
    envFileInputs: loadedEnvFiles.inputs,
  };
});

export type ResolvedServiceSeed = Effect.Success<ReturnType<typeof resolveSeed>>;

export const resolveServiceSeeds = Effect.fn("AppPlanner.resolveServices")(function* (
  input: ServiceSeedInput,
) {
  const { landofile, fileSystem, appRoot } = input;
  const topLevelEnvFiles = yield* loadTopLevelEnvFiles({
    appRoot,
    envFiles: landofile.env_file ?? [],
    fileSystem,
  });
  // A service type publishes credentials while it resolves, and another
  // service may read them through services.<name>.creds.*, so services resolve
  // in reference order. Each one's deferred sites are evaluated against the
  // credentials published so far, before env files and user defaults merge in
  // (those values are never interpolated) and before its type runs, so the
  // type sees concrete values wherever it reads its configuration.
  const order = orderServicesByCredsReferences({
    landofile,
    deferredSites: input.deferredSites,
    landofilePath: input.landofilePath,
  });
  if (Result.isFailure(order)) return yield* Effect.fail(order.failure);
  const serviceCredsScope: Record<string, { readonly creds?: ServiceCreds }> = {};
  const resolvedByName = new Map<string, ResolvedServiceSeed>();
  for (const name of order.success) {
    const authoredService = landofile.services?.[ServiceName.make(name)];
    if (authoredService === undefined) continue;
    const service = yield* materializeServiceScopeSites({
      value: authoredService,
      landofilePath: input.landofilePath,
      pathPrefix: ["services", name],
      deferredSites: input.deferredSites,
      context: serviceScopeContext({
        landofile,
        appSlug: input.appSlug,
        defaultDomain: input.defaultDomain,
        services: serviceCredsScope,
      }),
    });
    const seed = yield* resolveSeed(input, topLevelEnvFiles, name, service);
    serviceCredsScope[name] = serviceCredsScopeEntry(seed.resolution.normalizedConfig.creds);
    resolvedByName.set(name, seed);
  }
  // Seeds keep declaration order; only resolution ran in reference order.
  const services = Object.keys(landofile.services ?? {}).flatMap((name) => {
    const seed = resolvedByName.get(name);
    return seed === undefined ? [] : [seed];
  });
  const credsScope: ServiceCredsScope = serviceCredsScope;
  return { services, topLevelEnvFiles, serviceCredsScope: credsScope };
});
