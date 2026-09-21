import { getLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { findLandofilePath } from "@lando/landofile/discovery";
import { LandofileValidationError } from "@lando/sdk/errors";
import type { LandofileShape, ProviderCapabilities } from "@lando/sdk/schema";
import type { ConfigService, FileSystem, PathsService, PluginRegistry } from "@lando/sdk/services";
import { type Context, Effect } from "effect";
import {
  CAPABILITY_DEFAULT_PROVIDER_ID,
  readProviderEnvVar,
  resolveProviderSelection,
} from "../providers/precedence.ts";
import { resolveUserAppDefaults } from "./app-defaults.ts";
import { compileEffectiveTooling, validateServiceTypeReservedToolingNames } from "./effective-tooling.ts";
import { unknownEventError, unknownEventName, validEventNames } from "./event-names.ts";
import { resolveServiceSeeds } from "./service-seeds.ts";
import { contributionId, resolveHostFacts } from "./service-types.ts";

export interface KnownEventSetInput {
  readonly landofile: LandofileShape;
  readonly pluginRegistry: Context.Tag.Service<typeof PluginRegistry>;
  readonly configService: Context.Tag.Service<typeof ConfigService> | undefined;
  readonly fileSystem: Context.Tag.Service<typeof FileSystem> | undefined;
  readonly pathsService: Context.Tag.Service<typeof PathsService> | undefined;
  readonly capabilities?: ProviderCapabilities;
  readonly file?: string;
}

export const resolveKnownEventSet = (input: KnownEventSetInput) =>
  Effect.gen(function* () {
    const { landofile, pluginRegistry, configService, fileSystem, pathsService } = input;
    const appRoot = getLandofileAppRoot(landofile) ?? process.cwd();
    const landofilePath = input.file ?? `${appRoot}/.lando.yml`;
    const appName = landofile.name ?? "app";
    const host = resolveHostFacts();
    const encodedMetadata = {
      resolvedAt: new Date().toISOString(),
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
                  issues: ["network"],
                }),
            ),
          );
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
            message: `Failed to enumerate plugin contributions: ${error instanceof Error ? error.message : String(error)}.`,
            file: landofilePath,
            issues: [],
          }),
      ),
    );
    const seeds = yield* resolveServiceSeeds({
      landofile,
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
              issues: ["events"],
            }),
        }));
      return yield* Effect.fail(unknownEventError(unknown, knownEventNames, canonicalPath ?? landofilePath));
    }
    return {
      ...seeds,
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

export type KnownEventSetResolution = Effect.Effect.Success<ReturnType<typeof resolveKnownEventSet>>;
