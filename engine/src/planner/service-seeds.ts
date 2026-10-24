import { compiledValueError } from "@lando/landofile/compiled-sites";
import { LandofileValidationError, ServiceTypeCollisionError } from "@lando/sdk/errors";
import type {
  CompilationContext,
  LandofileShape,
  LogSource,
  ParsedPendingSite,
  ProviderCapabilities,
  ServiceConfig,
} from "@lando/sdk/schema";
import { ServiceConfig as ServiceConfigSchema, ServiceName, validationIssue } from "@lando/sdk/schema";
import type { FileSystem, PluginRegistry, ServiceTypeInput } from "@lando/sdk/services";
import { type Context, Effect, Iterable, Result, Schema } from "effect";
import { isComposeBuild } from "../services/compose-build-artifact.ts";
import { normalizeConnectionClients } from "../services/connection-client-resolution.ts";
import { type UserAppDefaults, withUserAppDefaults } from "./app-defaults.ts";
import { loadServiceEnvFiles, loadTopLevelEnvFiles } from "./env-files.ts";
import {
  type DeferredExpressionSites,
  type ServiceCredsScope,
  materializeServiceScopeSites,
  orderServicesByCredsReferences,
  serviceScopeContext,
} from "./landofile-scopes.ts";
import { loadAuthorizedServiceProjectFiles } from "./node-authoring.ts";
import { type PlannerIssue, attributePlannerIssue } from "./resolved-validation.ts";
import { validateServiceSeed } from "./seed-validation.ts";
import { serviceExpressionFacts } from "./service-credential-facts.ts";
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
  readonly appDefaults: UserAppDefaults;
  readonly registeredServiceTypeIds: ReadonlyArray<string>;
  readonly metadata: ServiceTypeInput["metadata"];
  readonly host: ServiceTypeInput["host"];
  readonly provider: ServiceTypeInput["provider"];
  readonly capabilities?: ProviderCapabilities;
}

const resolveSeed = Effect.fnUntraced(function* (
  input: ServiceSeedInput,
  topLevelEnvFiles: Effect.Success<ReturnType<typeof loadTopLevelEnvFiles>>,
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
        remediation: "Remove image or replace build with a Lando build-script block.",
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
    Effect.mapError((error) => {
      if (error instanceof ServiceTypeCollisionError) return serviceTypeCollision(appRoot, name, error);
      // A registered type that fails to load is a plugin problem, not an unknown type.
      const baseId = serviceTypeId.split(":")[0];
      return registeredServiceTypeIds.some((id) => id === serviceTypeId || id === baseId)
        ? servicePlanError(appRoot, name, error)
        : unsupportedServiceType(appRoot, name, serviceTypeId, registeredServiceTypeIds);
    }),
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
    .pipe(
      Effect.flatMap((raw) => normalizeConnectionClients(serviceType, name, { raw })),
      Effect.mapError((error) => servicePlanError(appRoot, name, error)),
    );
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
  const issues: PlannerIssue[] = [];
  const record = (error: LandofileValidationError) =>
    issues.push(
      ...error.issues.map((issue) =>
        attributePlannerIssue(landofile, { ...issue, rule: "landofile.service" }),
      ),
    );
  const loadedTopLevelEnvFiles = yield* loadTopLevelEnvFiles({
    appRoot,
    envFiles: landofile.env_file ?? [],
    fileSystem,
  }).pipe(Effect.result);
  if (Result.isFailure(loadedTopLevelEnvFiles)) record(loadedTopLevelEnvFiles.failure);
  const topLevelEnvFiles = Result.isSuccess(loadedTopLevelEnvFiles)
    ? loadedTopLevelEnvFiles.success
    : { environment: {}, inputs: [] };
  // A service type publishes credentials while it resolves, and another
  // service may read them through services.<name>.creds.*, so services resolve
  // in reference order. Each one's deferred sites are evaluated against the
  // credentials published so far, before env files and user defaults merge in
  // (those values are never interpolated) and before its type runs, so the
  // type sees concrete values wherever it reads its configuration.
  const order = yield* Effect.fromResult(
    orderServicesByCredsReferences({
      landofile,
      deferredSites: input.deferredSites,
      landofilePath: input.landofilePath,
    }),
  );
  const serviceCredsScope: Record<string, ServiceCredsScope[string]> = {};
  let pendingSites: readonly ParsedPendingSite[] = input.deferredSites;
  const documents = { ...landofile.services };
  const resolvedByName = new Map<
    string,
    ResolvedServiceSeed & { readonly logSources: ReadonlyArray<LogSource> }
  >();
  const unavailable = new Set<string>();
  for (const name of order.order) {
    if (Iterable.some(order.references.get(name) ?? [], (ref) => unavailable.has(ref))) {
      unavailable.add(name);
      continue;
    }
    const authoredService = landofile.services?.[ServiceName.make(name)];
    if (authoredService === undefined) continue;
    const materialized = yield* materializeServiceScopeSites({
      value: authoredService,
      landofilePath: input.landofilePath,
      pathPrefix: ["services", name],
      deferredSites: pendingSites,
      context: serviceScopeContext({
        landofile,
        context: input.context,
        appSlug: input.appSlug,
        defaultDomain: input.defaultDomain,
        services: serviceCredsScope,
      }),
    });
    const service = yield* Schema.decodeUnknownEffect(Schema.toType(ServiceConfigSchema))(
      materialized.document,
    ).pipe(
      Effect.mapError((cause) =>
        compiledValueError(cause, {
          filePath: input.landofilePath,
          pendingSites,
          pathPrefix: ["services", name],
        }),
      ),
    );
    documents[ServiceName.make(name)] = service;
    pendingSites = pendingSites.filter((site) => !(site.path[0] === "services" && site.path[1] === name));
    const resolved = yield* resolveSeed(input, topLevelEnvFiles, name, service).pipe(
      Effect.map(Result.succeed),
      Effect.catchTag("LandofileValidationError", (error) => Effect.succeed(Result.fail(error))),
    );
    if (Result.isFailure(resolved)) {
      unavailable.add(name);
      record(resolved.failure);
      continue;
    }
    const seed = resolved.success;
    const facts = serviceExpressionFacts(seed.resolution);
    if (facts !== undefined) serviceCredsScope[name] = facts;
    const checked = yield* validateServiceSeed(seed, appRoot, input.landofilePath);
    for (const error of checked.errors) record(error);
    resolvedByName.set(name, { ...seed, logSources: checked.logSources });
  }
  // Seeds keep declaration order; only resolution ran in reference order.
  const services = Object.keys(landofile.services ?? {}).flatMap((name) => {
    const seed = resolvedByName.get(name);
    return seed === undefined ? [] : [seed];
  });
  return {
    services,
    topLevelEnvFiles,
    serviceCredsScope,
    issues,
    unavailable,
    document: { ...landofile, services: documents },
    pendingSites,
    context: input.context,
  };
});
