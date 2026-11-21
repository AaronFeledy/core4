import { compiledValueError } from "@lando/landofile/compiled-sites";
import type { LandofileProvenance } from "@lando/landofile/provenance";
import { mapFailures } from "@lando/sdk/command-result";
import { LandofileValidationError, ServiceTypeCollisionError } from "@lando/sdk/errors";
import type { ExpressionContext } from "@lando/sdk/expressions";
import type {
  CompilationContext,
  LandofileShape,
  ProviderCapabilities,
  ServiceConfig,
} from "@lando/sdk/schema";
import { ServiceConfig as ServiceConfigSchema, validationIssue } from "@lando/sdk/schema";
import type { FileSystem, PluginRegistry, ServiceTypeInput } from "@lando/sdk/services";
import { type Context, Effect, Result, Schema } from "effect";
import { isComposeBuild } from "../services/compose-build-artifact.ts";
import { normalizeConnectionClients } from "../services/connection-client-resolution.ts";
import { type UserAppDefaults, withUserAppDefaults } from "./app-defaults.ts";
import { loadServiceEnvFiles, type loadTopLevelEnvFiles } from "./env-files.ts";
import { type DeferredExpressionSites, materializeServiceScopeSites } from "./landofile-scopes.ts";
import { lowerLauncher } from "./launchers.ts";
import { loadAuthorizedServiceProjectFiles } from "./node-authoring.ts";
import { materializeServicePort } from "./service-port-scope.ts";
import type { PlanningUnavailableSite } from "./service-seeds.ts";
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
  readonly provenance?: LandofileProvenance | undefined;
  readonly context: CompilationContext;
  readonly landofilePath: string;
  readonly appSlug: string;
  readonly defaultDomain: string;
  /** Value sites the identity pass left for the service scope (see landofile-scopes.ts). */
  readonly deferredSites: DeferredExpressionSites;
  readonly pluginRegistry: Context.Service.Shape<typeof PluginRegistry>;
  readonly fileSystem: Context.Service.Shape<typeof FileSystem> | undefined;
  readonly appRoot: string;
  readonly appName: string;
  readonly dataName?: string;
  readonly appDefaults: UserAppDefaults;
  readonly registeredServiceTypeIds: ReadonlyArray<string>;
  readonly metadata: ServiceTypeInput["metadata"];
  readonly host: ServiceTypeInput["host"];
  readonly provider: ServiceTypeInput["provider"];
  readonly capabilities?: ProviderCapabilities;
  /**
   * Isolable load failures whose destinations are already known. A service with any blocked path is
   * unavailable before ordering and type resolution; reasons stay off the issues channel.
   */
  readonly unavailableSites?: readonly PlanningUnavailableSite[];
  readonly mode?: "diagnostic";
}

export const resolveSeed = Effect.fnUntraced(function* (
  input: ServiceSeedInput,
  topLevelEnvFiles: Effect.Success<ReturnType<typeof loadTopLevelEnvFiles>>,
  seed: {
    readonly name: string;
    readonly service: ServiceConfig;
    readonly sites: DeferredExpressionSites;
    readonly context: ExpressionContext;
  },
) {
  const { name, sites, context } = seed;
  const pathPrefix = ["services", name];
  const materialized = yield* materializeServiceScopeSites({
    value: seed.service,
    landofilePath: input.landofilePath,
    pathPrefix,
    deferredSites: sites,
    context,
  });
  const scopedService = yield* Schema.decodeUnknownEffect(Schema.toType(ServiceConfigSchema))(
    materialized.document,
  ).pipe(
    mapFailures((cause) =>
      compiledValueError(cause, { filePath: input.landofilePath, pendingSites: sites, pathPrefix }),
    ),
  );
  const { pluginRegistry, fileSystem, appRoot, appName, appDefaults, registeredServiceTypeIds } = input;
  const serviceTypeId = serviceTypeFor(name, scopedService, registeredServiceTypeIds);
  const { image, build } = scopedService;
  if (image !== undefined && build !== undefined && isComposeBuild(build)) {
    return yield* Effect.fail(
      new LandofileValidationError({
        message: `Service ${name} must declare exactly one of image or a Compose build, not both. Remove image or replace build with a Lando build-script block.`,
        remediation: "Remove image or replace build with a Lando build-script block.",
        file: input.landofilePath,
        issues: [
          validationIssue(
            ["services", name, "build"],
            `Service ${name} must declare exactly one of image or a Compose build, not both. Remove image or replace build with a Lando build-script block.`,
          ),
        ],
      }),
    );
  }
  const { serviceType, version } = yield* loadServiceTypeWithVersion(pluginRegistry, serviceTypeId).pipe(
    mapFailures((error) => {
      if (error instanceof ServiceTypeCollisionError) return serviceTypeCollision(appRoot, name, error);
      // A registered type that fails to load is a plugin problem, not an unknown type.
      const baseId = serviceTypeId.split(":")[0];
      return registeredServiceTypeIds.some((id) => id === serviceTypeId || id === baseId)
        ? servicePlanError({ appRoot, serviceName: name, cause: error })
        : unsupportedServiceType(appRoot, name, serviceTypeId, registeredServiceTypeIds);
    }),
  );
  // A version on a type that publishes no matrix names a sibling type that does not exist, so
  // answer with the registered versioned siblings instead of a matrix error.
  if (version !== undefined && (serviceType.versions?.length ?? 0) === 0) {
    yield* Effect.fail(unsupportedServiceType(appRoot, name, serviceTypeId, registeredServiceTypeIds));
  }
  const resolvedArtifactTag = yield* resolvePinnedArtifactTag(appRoot, name, serviceType, version);
  const service = yield* materializeServicePort({
    service: scopedService,
    sites: materialized.pendingSites,
    context,
    serviceType,
    pathPrefix,
    landofilePath: input.landofilePath,
  });
  const loadedEnvFiles = yield* loadServiceEnvFiles({ appRoot, serviceName: name, service, fileSystem });
  const serviceWithEnvironment = withUserAppDefaults({
    service,
    defaults: appDefaults,
    topLevelEnvironment: topLevelEnvFiles.environment,
    serviceEnvironment: loadedEnvFiles.environment,
    hasEnvFiles: topLevelEnvFiles.inputs.length > 0 || loadedEnvFiles.inputs.length > 0,
  });
  const authored = authoredStorageScopes(appRoot, name, serviceWithEnvironment);
  if (authored.invalidCacheEntry !== undefined) yield* Effect.fail(authored.invalidCacheEntry);
  if (authored.globalEntry !== undefined) yield* Effect.fail(rejectGlobalScope(name, authored.globalEntry));
  const pinnedService: ServiceConfig =
    resolvedArtifactTag === undefined || serviceWithEnvironment.image !== undefined
      ? serviceWithEnvironment
      : { ...serviceWithEnvironment, image: resolvedArtifactTag };
  const projectFiles = yield* loadAuthorizedServiceProjectFiles({
    appRoot,
    name,
    service,
    serviceType,
    pinnedService,
    resolvedArtifactTag,
    fileSystem,
  });
  const contribution = yield* serviceType
    .resolve({
      name,
      service: pinnedService,
      appRoot,
      appName,
      ...(input.dataName === undefined ? {} : { dataName: input.dataName }),
      primary: name === "web",
      metadata: input.metadata,
      ...(input.host === undefined ? {} : { host: input.host }),
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
      projectFiles,
    })
    .pipe(
      Effect.flatMap((raw) => normalizeConnectionClients(serviceType, name, { raw })),
      mapFailures((error) => servicePlanError({ appRoot, serviceName: name, cause: error, projectFiles })),
    );
  const command = contribution.normalizedConfig.command;
  let resolution = contribution;
  if (command !== undefined && typeof command !== "string") {
    const lowered = lowerLauncher(command, { name, facts: { serviceTypeId, ...contribution } });
    if (Result.isFailure(lowered)) {
      const issue = lowered.failure;
      return yield* Effect.fail(
        new LandofileValidationError({
          message: issue.message,
          remediation: issue.suggestion,
          file: input.landofilePath,
          issues: [{ ...issue, path: ["services", name, "command"] }],
        }),
      );
    }
    resolution = {
      ...contribution,
      normalizedConfig: { ...contribution.normalizedConfig, command: lowered.success },
    };
  }
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
