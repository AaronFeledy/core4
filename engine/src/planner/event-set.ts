import { getLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { copyLandofileProvenance } from "@lando/landofile/copy-provenance";
import { findLandofilePath } from "@lando/landofile/discovery";
import { LandofileValidationError, causeMessage } from "@lando/sdk/errors";
import type { LandofileShape, ProviderCapabilities } from "@lando/sdk/schema";
import { validationIssue } from "@lando/sdk/schema";
import type { ConfigService, FileSystem, PathsService, PluginRegistry } from "@lando/sdk/services";
import { type Context, DateTime, Effect } from "effect";
import {
  CAPABILITY_DEFAULT_PROVIDER_ID,
  readProviderEnvVar,
  resolveProviderSelection,
} from "../providers/precedence.ts";
import { resolveUserAppDefaults } from "./app-defaults.ts";
import { compileEffectiveTooling, validateServiceTypeReservedToolingNames } from "./effective-tooling.ts";
import { unknownEventError, unknownEventName, validEventNames } from "./event-names.ts";
import {
  materializeLandofileScopes,
  materializeServiceScopeSites,
  serviceScopeContext,
} from "./landofile-scopes.ts";
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
}

export const resolveKnownEventSet = Effect.fn("AppPlanner.discover")(function* (input: KnownEventSetInput) {
  const { pluginRegistry, configService, fileSystem, pathsService } = input;
  let landofile = input.landofile;
  const appRoot = getLandofileAppRoot(landofile) ?? process.cwd();
  const landofilePath = input.file ?? `${appRoot}/.lando.yml`;
  const appName = landofile.name ?? "app";
  const host = resolveHostFacts();
  const encodedMetadata = {
    resolvedAt: DateTime.formatIso(yield* DateTime.now),
    source: landofilePath,
    runtime: 4 as const,
  };
  const globalConfig =
    configService === undefined
      ? undefined
      : yield* configService.load.pipe(
          Effect.mapError(
            (cause) =>
              new LandofileValidationError({
                message: `Global configuration could not be loaded for service network injection: ${cause.message}`,
                file: landofilePath,
                issues: [
                  validationIssue(
                    ["network"],
                    `Global configuration could not be loaded for service network injection: ${cause.message}`,
                  ),
                ],
              }),
          ),
        );
  const materialized = yield* materializeLandofileScopes({ landofile, appRoot, landofilePath, globalConfig });
  const { appSlug, defaultDomain, deferredSites } = materialized;
  landofile = materialized.landofile;
  const appDefaults = resolveUserAppDefaults(appName, appRoot, pathsService, globalConfig);
  const envProvider = readProviderEnvVar(process.env);
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
  if (deferredSites.length > 0) {
    const serviceScoped = yield* materializeServiceScopeSites({
      value: landofile,
      landofilePath,
      pathPrefix: [],
      deferredSites,
      context: serviceScopeContext({ landofile, appSlug, defaultDomain, services: seeds.serviceCredsScope }),
    });
    if (serviceScoped !== landofile) {
      copyLandofileProvenance(landofile, serviceScoped);
      landofile = serviceScoped;
    }
  }
  const toolingServices = seeds.services.map((entry) => ({
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
      input.file ??
      (yield* Effect.tryPromise({
        try: () => findLandofilePath(appRoot),
        catch: (cause) =>
          new LandofileValidationError({
            message: cause instanceof Error ? cause.message : "Cannot locate the canonical Landofile.",
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
    ...seeds,
    landofile,
    appSlug,
    defaultDomain,
    effectiveTooling,
    knownEventNames,
    appRoot,
    appName,
    landofilePath,
    host,
    encodedMetadata,
    globalConfig,
    appDefaults,
    provider,
    manifests,
  };
});

export type KnownEventSetResolution = Effect.Success<ReturnType<typeof resolveKnownEventSet>>;
