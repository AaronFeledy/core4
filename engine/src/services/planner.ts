import { type Context, Effect, Layer, Option } from "effect";

import {
  AppPlanner,
  CacheService,
  ConfigService,
  FileSystem,
  PathsService,
  PluginRegistry,
  ProcessRunner,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { resolveAppIdentity } from "../planner/app-identity.ts";
import { planApp } from "../planner/assemble.ts";
import {
  applyAuthoredDependencies,
  applyAuthoredHealthcheck,
  validateAuthoredAppMount,
} from "../planner/authored.ts";
import { DEFAULT_APP_MOUNT_EXCLUDES, mergeDefaultExcludes } from "../planner/file-sync.ts";
import { adoptMysqlVolume } from "../planner/mysql-volume.ts";
import { DEFAULT_PROXY_DOMAIN } from "../planner/naming.ts";
import { CertificateAuthorityResolver } from "../plugins/certificate-authority-resolver.ts";

export { AppPlanner } from "@lando/sdk/services";
export { prepareServiceMounts } from "../planner/mounts.ts";
export {
  applyAuthoredDependencies,
  applyAuthoredHealthcheck,
  DEFAULT_PROXY_DOMAIN,
  DEFAULT_APP_MOUNT_EXCLUDES,
  mergeDefaultExcludes,
  validateAuthoredAppMount,
};

export const layer = Layer.effect(
  AppPlanner,
  Effect.gen(function* () {
    const pluginRegistry = yield* PluginRegistry;
    const providerRegistry = yield* Effect.serviceOption(RuntimeProviderRegistry);
    const cacheService = yield* Effect.serviceOption(CacheService);
    const configService = yield* Effect.serviceOption(ConfigService);
    const fileSystem = yield* Effect.serviceOption(FileSystem);
    const pathsService = yield* Effect.serviceOption(PathsService);
    const processRunner = yield* Effect.serviceOption(ProcessRunner);
    const certificateAuthorityResolver = yield* Effect.serviceOption(CertificateAuthorityResolver);
    return AppPlanner.of({
      plan: Effect.fn("AppPlanner.plan")(function* (landofile, providerCapabilities) {
        const identity = yield* resolveAppIdentity(
          landofile.context.appRoot,
          Option.getOrUndefined(processRunner),
        );
        const plan = yield* planApp(
          pluginRegistry,
          Option.getOrUndefined(cacheService),
          Option.getOrUndefined(configService),
          Option.getOrUndefined(fileSystem),
          Option.getOrUndefined(pathsService),
          Option.getOrUndefined(certificateAuthorityResolver),
          landofile,
          providerCapabilities,
          identity.appRoot,
        );
        const identified = { ...plan, root: identity.appRoot, identity };
        return yield* adoptMysqlVolume(identified, Option.getOrUndefined(providerRegistry));
      }),
    } satisfies Context.Service.Shape<typeof AppPlanner>);
  }),
);
