import { getLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { copyLandofileProvenance } from "@lando/landofile/copy-provenance";
import { findLandofilePath } from "@lando/landofile/discovery";
import { landofileValidationError } from "@lando/landofile/validation";
import { LandofileValidationError, causeMessage } from "@lando/sdk/errors";
import type { LandofileShape, ProviderCapabilities } from "@lando/sdk/schema";
import { validationIssue } from "@lando/sdk/schema";
import type { ConfigService, FileSystem, PathsService, PluginRegistry } from "@lando/sdk/services";
import { type Context, DateTime, Effect, Iterable, Option, Result } from "effect";
import {
  CAPABILITY_DEFAULT_PROVIDER_ID,
  readProviderEnvVar,
  resolveProviderSelection,
} from "../providers/precedence.ts";
import { GlobalConfigSources } from "../services/config.ts";
import { resolveUserAppDefaults } from "./app-defaults.ts";
import { compileEffectiveTooling, validateServiceTypeReservedToolingNames } from "./effective-tooling.ts";
import { unknownEventError, unknownEventName, validEventNames } from "./event-names.ts";
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

export interface KnownEventSetInput {
  readonly landofile: LandofileShape;
  readonly pluginRegistry: Context.Service.Shape<typeof PluginRegistry>;
  readonly configService: Context.Service.Shape<typeof ConfigService> | undefined;
  readonly fileSystem: Context.Service.Shape<typeof FileSystem> | undefined;
  readonly pathsService: Context.Service.Shape<typeof PathsService> | undefined;
  readonly capabilities?: ProviderCapabilities;
  readonly file?: string;
  readonly appRoot?: string;
}

export const resolveLandofileForPlanning = Effect.fn("AppPlanner.resolve")(function* (
  input: KnownEventSetInput,
) {
  const { pluginRegistry, configService, fileSystem, pathsService } = input;
  let landofile = input.landofile;
  const appRoot = input.appRoot ?? getLandofileAppRoot(landofile) ?? process.cwd();
  const landofilePath = input.file ?? `${appRoot}/.lando.yml`;
  const appName = landofile.name ?? "app";
  const host = resolveHostFacts();
  const encodedMetadata = {
    resolvedAt: DateTime.formatIso(yield* DateTime.now),
    source: landofilePath,
    runtime: 4 as const,
  };
  const globalConfig = configService === undefined ? undefined : yield* configService.load;
  const materialized = yield* materializeLandofileScopes({ landofile, appRoot, landofilePath, globalConfig });
  const { appSlug, defaultDomain, deferredSites } = materialized;
  landofile = materialized.landofile;
  const appDefaults = resolveUserAppDefaults(appName, appRoot, pathsService, globalConfig);
  const captured = yield* Effect.serviceOption(GlobalConfigSources);
  const envProvider = readProviderEnvVar(
    Option.isNone(captured) ? process.env : captured.value.sources.env ? captured.value.env : {},
  );
  const configProvider = globalConfig?.defaultProviderId;
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
          message: `Failed to enumerate plugin contributions: ${causeMessage(error)}.`,
          remediation: "Repair the failing plugin registration and retry planning.",
          file: landofilePath,
          issues: [],
        }),
    ),
  );
  const seeds = yield* resolveServiceSeeds({
    landofile,
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
    ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
  });
  // Every service type has published its credentials now, so the sites the
  // identity pass deferred (tooling, extensions, and the services themselves)
  // resolve across the whole document before tooling is compiled.
  // Sites that read a service whose type failed to resolve cannot be evaluated;
  // the stage skips values holding them instead of reporting a cascade. A
  // computed member cannot be analyzed, so it is held back too.
  const blocked = new Set<string>();
  if (seeds.unavailable.size > 0) {
    for (const site of deferredSites) {
      const references = referencedServices([], [site], landofilePath);
      if (
        Result.isFailure(references) ||
        Iterable.some(references.success, (name) => seeds.unavailable.has(name))
      )
        blocked.add(deferredSiteKey(site.path));
    }
  }
  if (deferredSites.length > 0) {
    const serviceScoped = yield* materializeServiceScopeSites({
      value: landofile,
      landofilePath,
      pathPrefix: [],
      deferredSites: deferredSites.filter((site) => !blocked.has(deferredSiteKey(site.path))),
      context: serviceScopeContext({ landofile, appSlug, defaultDomain, services: seeds.serviceCredsScope }),
    });
    if (serviceScoped !== landofile) {
      copyLandofileProvenance(landofile, serviceScoped);
      landofile = serviceScoped;
    }
  }
  const validated = validateResolvedLandofile({ landofile, landofilePath, blocked });
  const issues = [...seeds.issues, ...validated.issues];
  if (issues.length > 0) return { _tag: "Invalid" as const, issues, landofile, landofilePath };
  return {
    _tag: "Resolved" as const,
    resolution: {
      ...seeds,
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
      manifests,
      routes: validated.routes,
      canonicalFile: input.file,
    },
  };
});

type ResolvedLandofile = Extract<
  Effect.Success<ReturnType<typeof resolveLandofileForPlanning>>,
  { readonly _tag: "Resolved" }
>["resolution"];

export const knownEventSetFrom = Effect.fn("AppPlanner.knownEvents")(function* (
  resolution: ResolvedLandofile,
) {
  const { landofile, appRoot, landofilePath } = resolution;
  const toolingServices = resolution.services.map((entry) => ({
    name: entry.name,
    serviceTypeId: entry.serviceType.id,
    ...(entry.resolution.tooling === undefined ? {} : { tooling: entry.resolution.tooling }),
  }));
  const effectiveTooling = compileEffectiveTooling({ landofile, services: toolingServices });
  const conflict = validateServiceTypeReservedToolingNames({ landofile, services: toolingServices });
  if (conflict !== undefined) yield* Effect.fail(conflict);
  const knownEventNames = validEventNames(effectiveTooling);
  const unknown = unknownEventName(landofile.events, knownEventNames);
  if (unknown !== undefined) {
    const canonicalPath =
      resolution.canonicalFile ??
      (yield* Effect.tryPromise({
        try: () => findLandofilePath(appRoot),
        catch: (cause) =>
          new LandofileValidationError({
            message: cause instanceof Error ? cause.message : "Cannot locate the canonical Landofile.",
            remediation: "Ensure the app root and its Landofile are readable, then retry planning.",
            file: landofilePath,
            issues: [
              validationIssue(
                ["events"],
                cause instanceof Error ? cause.message : "Cannot locate the canonical Landofile.",
              ),
            ],
          }),
      }));
    return yield* Effect.fail(unknownEventError(unknown, knownEventNames, canonicalPath ?? landofilePath));
  }
  return {
    ...resolution,
    effectiveTooling,
    knownEventNames,
  };
});

export const resolveKnownEventSet = Effect.fn("AppPlanner.discover")(function* (input: KnownEventSetInput) {
  const result = yield* resolveLandofileForPlanning(input);
  if (result._tag === "Invalid")
    return yield* Effect.fail(landofileValidationError(result.landofilePath, result.issues));
  return yield* knownEventSetFrom(result.resolution);
});

export type KnownEventSetResolution = Effect.Success<ReturnType<typeof resolveKnownEventSet>>;
