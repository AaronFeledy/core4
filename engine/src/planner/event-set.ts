import { compileInvocationSites, compiledValueError } from "@lando/landofile/compiled-sites";
import { copyLandofileProvenance } from "@lando/landofile/copy-provenance";
import { landofileValidationError } from "@lando/landofile/validation";
import { LandofileValidationError, causeMessage } from "@lando/sdk/errors";
import {
  LandofileShape,
  type LoadScopedLandofile,
  type ProviderCapabilities,
  type ProviderId,
  ServiceScopedLandofile,
  authoredProbeTargetError,
} from "@lando/sdk/schema";
import { ServiceName } from "@lando/sdk/schema";
import type { ConfigService, FileSystem, PathsService, PluginRegistry } from "@lando/sdk/services";
import { type Context, DateTime, Effect, Iterable, Result, Schema } from "effect";
import { hostProviderIdFrom } from "../providers/host-provider.ts";
import { resolveGpgAgentIntent } from "../subsystems/gpg-agent/intent.ts";
import { resolveUserAppDefaults } from "./app-defaults.ts";
import {
  compileEffectiveTooling,
  connectionClientOwners,
  disabledToolingSources,
  toolingBeforeDefaults,
} from "./effective-tooling.ts";
import { requireServiceProjection } from "./endpoint-availability.ts";
import { projectEndpoints } from "./endpoint-projection.ts";
import { validEventNames } from "./event-names.ts";
import { effectiveInvocationSites } from "./invocation-authority.ts";
import {
  deferredSiteKey,
  materializeLandofileScopes,
  materializeServiceScopeSites,
  referencedServices,
  serviceScopeContext,
} from "./landofile-scopes.ts";
import { validateResolvedLandofile } from "./resolved-validation.ts";
import { resolveServiceSeeds } from "./service-seeds.ts";
import { contributionId, resolveHostFacts } from "./service-types.ts";
import { toolingAndEventIssues } from "./tooling-event-issues.ts";

export interface KnownEventSetInput {
  readonly landofile: LoadScopedLandofile;
  readonly pluginRegistry: Context.Service.Shape<typeof PluginRegistry>;
  readonly configService: Context.Service.Shape<typeof ConfigService> | undefined;
  readonly fileSystem: Context.Service.Shape<typeof FileSystem> | undefined;
  readonly pathsService: Context.Service.Shape<typeof PathsService> | undefined;
  readonly capabilities?: ProviderCapabilities;
  readonly resolveCapabilities?: (provider: ProviderId) => ProviderCapabilities | undefined;
  readonly file?: string;
  readonly appRoot?: string;
}

export const resolveLandofileForPlanning = Effect.fn("AppPlanner.resolve")(function* (
  input: KnownEventSetInput,
) {
  const { pluginRegistry, configService, fileSystem, pathsService } = input;
  let landofile = input.landofile.document;
  const appRoot = input.appRoot ?? input.landofile.context.appRoot;
  const landofilePath = input.file ?? `${appRoot}/.lando.yml`;
  const appName = landofile.name ?? "app";
  const host = resolveHostFacts();
  const encodedMetadata = {
    resolvedAt: DateTime.formatIso(yield* DateTime.now),
    source: landofilePath,
    runtime: 4 as const,
  };
  const globalConfig = configService === undefined ? undefined : yield* configService.load;
  const materialized = yield* materializeLandofileScopes({
    landofile: input.landofile,
    appRoot,
    landofilePath,
    globalConfig,
  });
  const { appSlug, defaultDomain, deferredSites } = materialized;
  landofile = materialized.landofile;
  const appDefaults = resolveUserAppDefaults(appName, appRoot, pathsService, globalConfig);
  const hostProvider = yield* hostProviderIdFrom(globalConfig?.defaultProviderId);
  const provider = landofile.provider ?? hostProvider;
  const capabilities = input.capabilities ?? input.resolveCapabilities?.(provider);
  const manifests = yield* pluginRegistry.list.pipe(
    Effect.mapError(
      (error) =>
        new LandofileValidationError({
          message: `Failed to enumerate plugin contributions: ${causeMessage(error)}.`,
          remediation: "Repair the failing plugin registration and retry planning.",
          file: landofilePath,
          issues: [],
        }),
    ),
  );
  const seeds = yield* resolveServiceSeeds({
    landofile,
    context: materialized.context,
    landofilePath,
    appSlug,
    defaultDomain,
    deferredSites,
    pluginRegistry,
    fileSystem,
    appRoot,
    appName,
    appDefaults,
    host,
    provider,
    metadata: encodedMetadata,
    registeredServiceTypeIds: manifests.flatMap((manifest) =>
      (manifest.contributes?.serviceTypes ?? []).map(contributionId),
    ),
    ...(capabilities === undefined ? {} : { capabilities }),
  });
  // Every service type has published its credentials now, so the sites the
  // identity pass deferred (tooling, extensions, and the services themselves)
  // resolve across the whole document before tooling is compiled.
  // Sites that read a service whose type failed to resolve cannot be evaluated;
  // the stage skips values holding them instead of reporting a cascade. A
  // computed member cannot be analyzed, so it is held back too.
  const blocked = new Set<string>();
  if (seeds.unavailable.size > 0) {
    for (const site of seeds.pendingSites) {
      const references = referencedServices([], [site], landofilePath);
      if (
        Result.isFailure(references) ||
        Iterable.some(references.success, (name) => seeds.unavailable.has(name))
      )
        blocked.add(deferredSiteKey(site.path));
    }
  }
  let pendingSites = seeds.pendingSites;
  landofile = copyLandofileProvenance(landofile, seeds.document);
  if (pendingSites.length > 0) {
    const serviceScoped = yield* materializeServiceScopeSites({
      value: landofile,
      landofilePath,
      pathPrefix: [],
      deferredSites: pendingSites.filter((site) => !blocked.has(deferredSiteKey(site.path))),
      context: serviceScopeContext({
        landofile,
        context: materialized.context,
        appSlug,
        defaultDomain,
        services: seeds.serviceCredsScope,
      }),
    });
    const decoded = yield* Schema.decodeUnknownEffect(Schema.toType(LandofileShape))(
      serviceScoped.document,
    ).pipe(Effect.mapError((cause) => compiledValueError(cause, { filePath: landofilePath, pendingSites })));
    landofile = copyLandofileProvenance(landofile, decoded);
    pendingSites = [
      ...pendingSites.filter((site) => blocked.has(deferredSiteKey(site.path))),
      ...serviceScoped.pendingSites,
    ];
  }
  const validated = validateResolvedLandofile({ landofile, landofilePath, blocked, appSlug });
  const projection = yield* projectEndpoints({
    services: seeds.services,
    unavailable: seeds.unavailable,
    landofile,
    manifests,
    pluginRegistry,
    appName,
    appRoot,
    provider,
    host,
    env: materialized.context.env,
    gpgForward: resolveGpgAgentIntent({ landofile, globalConfig }).forward,
    routes: validated.routes,
  });
  const issues = [...seeds.issues, ...validated.issues, ...projection.issues];
  const resolution = {
    ...seeds,
    endpointProjection: projection,
    compiled: ServiceScopedLandofile.make({
      stage: "service-scoped",
      document: landofile,
      pendingSites,
      context: materialized.context,
    }),
    document: landofile,
    pendingSites,
    context: materialized.context,
    landofile,
    appSlug,
    defaultDomain,
    appRoot,
    appName,
    landofilePath,
    host,
    encodedMetadata,
    globalConfig,
    appDefaults,
    provider,
    hostProvider,
    capabilities,
    manifests,
    routes: validated.routes,
    canonicalFile: input.file,
  };
  if (issues.length > 0) return { _tag: "Invalid" as const, issues, resolution };
  return { _tag: "Resolved" as const, resolution };
});

export type ResolvedLandofile = Extract<
  Effect.Success<ReturnType<typeof resolveLandofileForPlanning>>,
  { readonly _tag: "Resolved" }
>["resolution"];

const knownEventSetFrom = Effect.fnUntraced(function* (resolution: ResolvedLandofile) {
  const { landofile } = resolution;
  const services = yield* Effect.forEach(resolution.services, (seed) =>
    requireServiceProjection(resolution.endpointProjection.services, seed.name, resolution.appRoot).pipe(
      Effect.map((projection) => ({ ...seed, ...projection })),
    ),
  );
  const toolingServices = resolution.services.map((entry) => ({
    name: entry.name,
    serviceTypeId: entry.serviceType.id,
    ...(entry.resolution.tooling === undefined ? {} : { tooling: entry.resolution.tooling }),
    connectionClientNames: entry.resolution.connectionClientNames ?? [],
  }));
  const effectiveTooling = compileEffectiveTooling({ landofile, services: toolingServices });
  const invocationSites = effectiveInvocationSites({
    landofile,
    taskNames: Object.keys(effectiveTooling),
    tasksBeforeDefaults: toolingBeforeDefaults({ landofile, services: toolingServices }),
    sites: yield* compileInvocationSites(
      resolution.pendingSites,
      serviceScopeContext({ ...resolution, services: resolution.serviceCredsScope }),
      landofile,
    ),
  });
  const knownEventNames = validEventNames(effectiveTooling);
  return {
    ...resolution,
    services,
    effectiveTooling,
    connectionClients: connectionClientOwners({ landofile, services: toolingServices }),
    disabledToolingSources: disabledToolingSources(landofile, effectiveTooling),
    invocationSites,
    knownEventNames,
  };
});

export const resolveKnownEventSet = Effect.fn("AppPlanner.discover")(function* (input: KnownEventSetInput) {
  const result = yield* resolveLandofileForPlanning(input);
  for (const [name, service] of Object.entries(result.resolution.landofile.services ?? {})) {
    for (const role of ["healthcheck", "readiness"] as const) {
      const probe = service[role];
      if (probe === undefined || probe === false) continue;
      const invalid = authoredProbeTargetError(probe, ServiceName.make(name), role);
      if (invalid !== undefined) return yield* Effect.fail(invalid);
    }
  }
  const issues = [
    ...(result._tag === "Invalid" ? result.issues : []),
    ...toolingAndEventIssues(result.resolution),
  ];
  if (issues.length > 0)
    return yield* Effect.fail(landofileValidationError(result.resolution.landofilePath, issues));
  return yield* knownEventSetFrom(result.resolution);
});

export type KnownEventSetResolution = Effect.Success<ReturnType<typeof resolveKnownEventSet>>;
