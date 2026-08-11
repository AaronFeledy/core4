import { type Context, Effect, Layer, Option } from "effect";

import {
  AppPlanner,
  CacheService,
  ConfigService,
  FileSystem,
  PathsService,
  PluginRegistry,
} from "@lando/sdk/services";

import { planApp } from "../planner/assemble.ts";
import {
  applyAuthoredAppMount,
  applyAuthoredDependencies,
  applyAuthoredHealthcheck,
} from "../planner/authored.ts";
import { FILE_SYNC_DEFAULT_EXCLUDES, mergeDefaultExcludes } from "../planner/file-sync.ts";
import { DEFAULT_PROXY_DOMAIN } from "../planner/naming.ts";
import { CertificateAuthorityResolver } from "../plugins/certificate-authority-resolver.ts";

export { AppPlanner } from "@lando/sdk/services";
export {
  applyAuthoredAppMount,
  applyAuthoredDependencies,
  applyAuthoredHealthcheck,
  DEFAULT_PROXY_DOMAIN,
  FILE_SYNC_DEFAULT_EXCLUDES,
  mergeDefaultExcludes,
};

export const AppPlannerLive = Layer.effect(
  AppPlanner,
  Effect.gen(function* () {
    const pluginRegistry = yield* PluginRegistry;
    const cacheService = yield* Effect.serviceOption(CacheService);
    const configService = yield* Effect.serviceOption(ConfigService);
    const fileSystem = yield* Effect.serviceOption(FileSystem);
    const pathsService = yield* Effect.serviceOption(PathsService);
    const certificateAuthorityResolver = yield* Effect.serviceOption(CertificateAuthorityResolver);
    return {
      plan: (landofile, providerCapabilities) =>
        planApp(
          pluginRegistry,
          Option.getOrUndefined(cacheService),
          Option.getOrUndefined(configService),
          Option.getOrUndefined(fileSystem),
          Option.getOrUndefined(pathsService),
          Option.getOrUndefined(certificateAuthorityResolver),
          landofile,
          providerCapabilities,
        ),
    } satisfies Context.Tag.Service<typeof AppPlanner>;
  }),
);
