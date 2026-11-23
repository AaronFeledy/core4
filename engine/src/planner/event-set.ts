import { compileInvocationSites } from "@lando/landofile/compiled-sites";
import { provenanceOf } from "@lando/landofile/provenance";
import { landofileValidationError, unavailableEntryPath } from "@lando/landofile/validation";
import { mapFailures } from "@lando/sdk/command-result";
import { LandofileValidationError, causeMessage } from "@lando/sdk/errors";
import {
  type AppIdentity,
  type LoadScopedLandofile,
  type ProviderCapabilities,
  type ProviderId,
  ServiceName,
  ServiceScopedLandofile,
  authoredProbeTargetError,
  landoNativeAppSlug,
  normalizeAppSlug,
} from "@lando/sdk/schema";
import type { ConfigService, FileSystem, PathsService, PluginRegistry } from "@lando/sdk/services";
import { type Context, DateTime, Effect, Result } from "effect";
import { routerEnabledFrom } from "../config/router-config.ts";
import { hostProviderIdFrom } from "../providers/host-provider.ts";
import { resolveGpgAgentIntent } from "../subsystems/gpg-agent/intent.ts";
import { resolveUserAppDefaults } from "./app-defaults.ts";
import { planServicePrimary } from "./effective-events.ts";
import { resolveEffectiveTooling } from "./effective-tooling.ts";
import { requireServiceProjection } from "./endpoint-availability.ts";
import { projectEndpoints } from "./endpoint-projection.ts";
import { validEventNames } from "./event-names.ts";
import { planningHostShellIssues } from "./host-shell-issues.ts";
import { effectiveInvocationSites } from "./invocation-authority.ts";
import { materializeLandofileScopes, pathIsBlocked, serviceScopeContext } from "./landofile-scopes.ts";
import { primaryServiceName } from "./primary-service.ts";
import { validateResolvedLandofile } from "./resolved-validation.ts";
import { applyRouteDemandedCertificates } from "./route-certificate-defaults.ts";
import { type PlanningUnavailableSite, resolveServiceSeeds } from "./service-seeds.ts";
import { contributionId, resolveHostFacts } from "./service-types.ts";
import { toolingAndEventIssues } from "./tooling-event-issues.ts";
import { materializeWholeDocument, pendingAfterSeeds } from "./whole-document-expressions.ts";

export interface KnownEventSetInput {
  readonly identity?: AppIdentity | undefined;
  readonly dataName?: string;
  readonly landofile: LoadScopedLandofile;
  readonly pluginRegistry: Context.Service.Shape<typeof PluginRegistry>;
  readonly configService: Context.Service.Shape<typeof ConfigService> | undefined;
  readonly fileSystem: Context.Service.Shape<typeof FileSystem> | undefined;
  readonly pathsService: Context.Service.Shape<typeof PathsService> | undefined;
  readonly capabilities?: ProviderCapabilities;
  readonly resolveCapabilities?: (provider: ProviderId) => ProviderCapabilities | undefined;
  readonly file?: string;
  readonly appRoot?: string;
  /** Isolated load failures to keep unavailable during lint resolution. */
  readonly unavailableSites?: readonly PlanningUnavailableSite[];
}

export type { PlanningUnavailableSite };

const resolveLandofile = Effect.fn("AppPlanner.resolve")(function* (
  input: KnownEventSetInput,
  mode?: "diagnostic",
) {
  const unavailableSites = input.unavailableSites ?? [];
  const { pluginRegistry, configService, fileSystem, pathsService } = input;
  let landofile = input.landofile.document;
  const appRoot = input.appRoot ?? input.landofile.context.appRoot;
  const landofilePath = input.file ?? provenanceOf(input.landofile)?.landofilePath ?? appRoot;
  const appName = landofile.name ?? "app";
  const dataName = input.dataName ?? appName;
  const host = resolveHostFacts();
  const encodedMetadata = {
    resolvedAt: DateTime.formatIso(yield* DateTime.now),
    source: landofilePath,
    runtime: 4 as const,
  };
  const globalConfig = configService === undefined ? undefined : yield* configService.load;
  const loadBlocked =
    unavailableSites.length === 0
      ? undefined
      : unavailableSites.map(({ path }) => unavailableEntryPath(path));
  const heldSites =
    loadBlocked && input.landofile.pendingSites.filter((site) => pathIsBlocked(loadBlocked, site.path));
  const materialized = yield* materializeLandofileScopes({
    landofile: !heldSites?.length
      ? input.landofile
      : {
          ...input.landofile,
          pendingSites: input.landofile.pendingSites.filter((site) => !pathIsBlocked(loadBlocked, site.path)),
        },
    appRoot,
    landofilePath,
    globalConfig,
  });
  const { provenance } = materialized;
  const { appSlug, defaultDomain, deferredSites } = materialized;
  const nativeSlug = landoNativeAppSlug({ slug: appSlug, identity: input.identity });
  landofile = materialized.landofile;
  const appDefaults = resolveUserAppDefaults(appName, appRoot, pathsService, globalConfig);
  const hostProvider = yield* hostProviderIdFrom(globalConfig?.defaultProviderId);
  const provider = landofile.provider ?? hostProvider;
  const capabilities = input.capabilities ?? input.resolveCapabilities?.(provider);
  const manifests = yield* pluginRegistry.list.pipe(
    mapFailures(
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
    dataName,
    nativeDataSlug: landoNativeAppSlug({
      slug: appSlug,
      identity: input.identity,
      dataSlug: normalizeAppSlug(dataName, appRoot),
    }),
    landofile,
    provenance,
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
    ...(unavailableSites.length === 0 ? {} : { unavailableSites }),
    ...(mode === undefined ? {} : { mode }),
  });
  const { available, blocked, dependentSkips } = pendingAfterSeeds(seeds, landofilePath);
  const scoped = yield* materializeWholeDocument({
    landofile: seeds.document,
    landofilePath,
    pendingSites: available,
    context: serviceScopeContext({
      ...materialized,
      landofile: seeds.document,
      services: seeds.serviceCredsScope,
    }),
  }).pipe(
    Effect.map(Result.succeed),
    Effect.catchTag("ConfigExpressionError", (error) =>
      mode === "diagnostic" ? Effect.succeed(Result.fail(error)) : Effect.fail(error),
    ),
  );
  if (Result.isFailure(scoped))
    return {
      _tag: "ExpressionAborted" as const,
      error: scoped.failure,
      issues: seeds.issues,
      dependentSkips,
    };
  landofile = scoped.success.document;
  const { pendingSites } = scoped.success;
  const blockedPaths = blocked.map((site) => site.path);
  const validated = validateResolvedLandofile({
    landofile,
    provenance,
    landofilePath,
    blocked: blockedPaths,
    loadBlocked,
    appSlug,
    nativeSlug,
  });
  // A generated HTTPS route makes an owned Apache-style launcher demand its own
  // certificate. Decide once here so endpoint projection, assembly, cache
  // identity, and tooling all read the same effective `certs` value.
  const effectiveSeeds = {
    ...seeds,
    services: applyRouteDemandedCertificates({
      services: seeds.services,
      routes: validated.routes,
      routerEnabled: routerEnabledFrom(globalConfig?.router, landofile.router),
    }),
  };
  const projection = yield* projectEndpoints({
    dataName,
    provenance,
    appSlug,
    services: effectiveSeeds.services,
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
    ...effectiveSeeds,
    endpointProjection: projection,
    compiled: ServiceScopedLandofile.make({
      stage: "service-scoped",
      document: landofile,
      pendingSites: [...pendingSites, ...blocked, ...(heldSites ?? [])],
      context: materialized.context,
      provenance,
    }),
    provenance,
    document: landofile,
    pendingSites,
    context: materialized.context,
    landofile,
    blocked: blocked.length === 0 ? loadBlocked : [...(loadBlocked ?? []), ...blockedPaths],
    appSlug,
    defaultDomain,
    appRoot,
    appName,
    landofilePath,
    dataName,
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
    toolingResolution: resolveEffectiveTooling({
      landofile,
      provenance,
      primary: primaryServiceName(
        Object.fromEntries(
          effectiveSeeds.services.map(({ name, resolution }) => [
            name,
            { primary: planServicePrimary(name, resolution.normalizedConfig.primary) },
          ]),
        ),
      ),
      services: effectiveSeeds.services.map((entry) => ({
        name: entry.name,
        serviceTypeId: entry.serviceType.id,
        ...entry.resolution,
      })),
    }),
  };
  if (issues.length > 0) return { _tag: "Invalid" as const, issues, resolution, dependentSkips };
  return { _tag: "Resolved" as const, resolution, dependentSkips };
});

export const resolveLandofileForLint = (input: KnownEventSetInput) => resolveLandofile(input, "diagnostic");

export const resolveLandofileForPlanning = (input: KnownEventSetInput) =>
  resolveLandofile(input).pipe(
    Effect.flatMap((result) =>
      result._tag === "ExpressionAborted" ? Effect.fail(result.error) : Effect.succeed(result),
    ),
  );

export type ResolvedLandofile = Extract<
  Effect.Success<ReturnType<typeof resolveLandofileForPlanning>>,
  { readonly _tag: "Resolved" }
>["resolution"];

/** Invocation-time expression sites of the effective tooling and events, compiled once per resolution. */
export const invocationSitesOf = Effect.fnUntraced(function* (resolution: ResolvedLandofile) {
  const { landofile } = resolution;
  const { tasks, beforeDefaults } = resolution.toolingResolution;
  return effectiveInvocationSites({
    landofile,
    taskNames: Object.keys(tasks),
    tasksBeforeDefaults: beforeDefaults,
    sites: yield* compileInvocationSites(
      resolution.pendingSites,
      serviceScopeContext({ ...resolution, services: resolution.serviceCredsScope }),
      landofile,
    ),
  });
});

const knownEventSetFrom = Effect.fnUntraced(function* (
  resolution: ResolvedLandofile,
  invocationSites: Effect.Success<ReturnType<typeof invocationSitesOf>>,
) {
  const services = yield* Effect.forEach(resolution.services, (seed) =>
    requireServiceProjection(resolution.endpointProjection.services, seed.name, resolution.appRoot).pipe(
      Effect.map((projection) => ({ ...seed, ...projection })),
    ),
  );
  const {
    tasks: effectiveTooling,
    provenance: toolingProvenance,
    internalNames,
    connectionClients,
  } = resolution.toolingResolution;
  const knownEventNames = validEventNames(effectiveTooling, internalNames);
  return {
    ...resolution,
    services,
    effectiveTooling,
    connectionClients,
    toolingProvenance,
    internalNames,
    invocationSites,
    knownEventNames,
  };
});

export const resolveKnownEventSet = Effect.fn("AppPlanner.discover")(function* (
  input: KnownEventSetInput,
  resolution?: ResolvedLandofile,
) {
  const result =
    resolution === undefined
      ? yield* resolveLandofileForPlanning(input)
      : { _tag: "Resolved" as const, resolution };
  for (const [name, service] of Object.entries(result.resolution.landofile.services ?? {})) {
    for (const role of ["healthcheck", "readiness"] as const) {
      const probe = service[role];
      if (probe === undefined || probe === false) continue;
      const invalid = authoredProbeTargetError(probe, ServiceName.make(name), role);
      if (invalid !== undefined) return yield* Effect.fail(invalid);
    }
  }
  const invocationSites = yield* invocationSitesOf(result.resolution);
  const issues = [
    ...(result._tag === "Invalid" ? result.issues : []),
    ...toolingAndEventIssues(result.resolution),
    ...planningHostShellIssues(result.resolution, invocationSites),
  ];
  if (issues.length > 0)
    return yield* Effect.fail(
      landofileValidationError(result.resolution.landofilePath, issues, {
        appRoot: result.resolution.appRoot,
      }),
    );
  return yield* knownEventSetFrom(result.resolution, invocationSites);
});

export type KnownEventSetResolution = Effect.Success<ReturnType<typeof resolveKnownEventSet>>;
