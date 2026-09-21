import { LandofileValidationError, ServiceTypeCollisionError } from "@lando/sdk/errors";
import type { LandofileShape, ProviderCapabilities, ServiceConfig } from "@lando/sdk/schema";
import type { FileSystem, PluginRegistry, ServiceTypeInput } from "@lando/sdk/services";
import { type Context, Effect } from "effect";
import { isComposeBuild } from "../services/compose-build-artifact.ts";
import { type UserAppDefaults, withUserAppDefaults } from "./app-defaults.ts";
import { loadServiceEnvFiles, loadTopLevelEnvFiles } from "./env-files.ts";
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
  readonly pluginRegistry: Context.Tag.Service<typeof PluginRegistry>;
  readonly fileSystem: Context.Tag.Service<typeof FileSystem> | undefined;
  readonly appRoot: string;
  readonly appName: string;
  readonly appDefaults: UserAppDefaults;
  readonly registeredServiceTypeIds: ReadonlyArray<string>;
  readonly metadata: ServiceTypeInput["metadata"];
  readonly host: ServiceTypeInput["host"];
  readonly provider: ServiceTypeInput["provider"];
  readonly capabilities?: ProviderCapabilities;
}

export const resolveServiceSeeds = (input: ServiceSeedInput) =>
  Effect.gen(function* () {
    const { landofile, pluginRegistry, fileSystem, appRoot, appName, appDefaults, registeredServiceTypeIds } =
      input;
    const topLevelEnvFiles = yield* loadTopLevelEnvFiles({
      appRoot,
      envFiles: landofile.env_file ?? [],
      fileSystem,
    });
    const services = yield* Effect.forEach(Object.entries(landofile.services ?? {}), ([name, service]) =>
      Effect.gen(function* () {
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
              issues: [`services.${name}.build`],
            }),
          );
        }
        const authored = authoredStorageScopes(appRoot, name, serviceWithEnvironment);
        if (authored.invalidCacheEntry !== undefined) yield* Effect.fail(authored.invalidCacheEntry);
        if (authored.globalEntry !== undefined)
          yield* Effect.fail(rejectGlobalScope(appRoot, name, authored.globalEntry));
        const serviceTypeId = serviceTypeFor(name, serviceWithEnvironment);
        const { serviceType, version } = yield* loadServiceTypeWithVersion(
          pluginRegistry,
          serviceTypeId,
        ).pipe(
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
      }),
    );
    return { services, topLevelEnvFiles };
  });

export type ResolvedServiceSeed = Effect.Effect.Success<
  ReturnType<typeof resolveServiceSeeds>
>["services"][number];
