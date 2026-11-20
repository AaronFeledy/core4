import { compiledValueError } from "@lando/landofile/compiled-sites";
import type { LandofileProvenance } from "@lando/landofile/provenance";
import { mapFailures } from "@lando/sdk/command-result";
import type { LandofileLoadFailure } from "@lando/sdk/errors";
import { LandofileValidationError, ServiceTypeCollisionError } from "@lando/sdk/errors";
import type {
  CompilationContext,
  LandofileShape,
  LogSource,
  ParsedPendingSite,
  ProviderCapabilities,
  ServiceConfig,
  ValidationIssuePath,
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
import { lowerLauncher } from "./launchers.ts";
import { normalizeAppSlug } from "./naming.ts";
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

/** Load-time failure whose effective destination is known; seeds service unavailability. */
export interface PlanningUnavailableSite {
  readonly path: ValidationIssuePath;
  readonly failure: LandofileLoadFailure;
}

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
  const authored = authoredStorageScopes(appRoot, name, serviceWithEnvironment);
  if (authored.invalidCacheEntry !== undefined) yield* Effect.fail(authored.invalidCacheEntry);
  if (authored.globalEntry !== undefined) yield* Effect.fail(rejectGlobalScope(name, authored.globalEntry));
  const serviceTypeId = serviceTypeFor(name, serviceWithEnvironment);
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

export const resolveServiceSeeds = Effect.fn("AppPlanner.resolveServices")(function* (
  input: ServiceSeedInput,
) {
  const { landofile, fileSystem, appRoot } = input;
  const appSlug = normalizeAppSlug(input.dataName ?? landofile.name ?? "app", appRoot);
  const issues: PlannerIssue[] = [];
  const record = (error: LandofileValidationError) => {
    const attributed = error.issues.map((issue) =>
      attributePlannerIssue(input.provenance, { ...issue, rule: "landofile.service" }),
    );
    issues.push(...attributed);
    return attributed;
  };
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
  const serviceCredsScope: Record<string, ServiceCredsScope[string]> = {};
  let pendingSites: readonly ParsedPendingSite[] = input.deferredSites;
  const documents = { ...landofile.services };
  const resolvedByName = new Map<
    string,
    ResolvedServiceSeed & { readonly logSources: ReadonlyArray<LogSource> }
  >();
  const unavailable = new Map<string, readonly PlannerIssue[]>();
  // Seed load-failure sites before ordering consumers so credential and endpoint cascades apply.
  for (const site of input.unavailableSites ?? []) {
    const [section, name] = site.path;
    if ((section !== "services" && section !== "proxy") || typeof name !== "string") continue;
    if (landofile.services?.[ServiceName.make(name)] === undefined) continue;
    // Loading already reported this failure; keep the reason only for dependency cascades.
    const reason: PlannerIssue = {
      path: site.path,
      rule: "landofile.load",
      message: site.failure.message,
      suggestion: site.failure.remediation,
    };
    unavailable.set(name, [...(unavailable.get(name) ?? []), reason]);
  }
  const order = yield* Effect.fromResult(
    orderServicesByCredsReferences({
      landofile,
      deferredSites: input.deferredSites.filter(
        ({ path }) => path[0] !== "services" || typeof path[1] !== "string" || !unavailable.has(path[1]),
      ),
      landofilePath: input.landofilePath,
    }),
  );
  for (const name of order.order) {
    if (unavailable.has(name)) continue;
    if (Iterable.some(order.references.get(name) ?? [], (ref) => unavailable.has(ref))) {
      unavailable.set(name, [
        ...new Set([...(order.references.get(name) ?? [])].flatMap((ref) => unavailable.get(ref) ?? [])),
      ]);
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
      mapFailures((cause) =>
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
      unavailable.set(name, record(resolved.failure));
      continue;
    }
    const seed = resolved.success;
    const facts = serviceExpressionFacts(seed.resolution);
    if (facts !== undefined) serviceCredsScope[name] = facts;
    const checked = yield* validateServiceSeed(
      seed,
      { appRoot, appSlug, serviceName: name, configs: landofile.configs },
      input.landofilePath,
    );
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
