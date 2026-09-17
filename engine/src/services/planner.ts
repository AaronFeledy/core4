import { type Context, Effect, Layer, Option } from "effect";

import { getLandofileAppRoot } from "@lando/landofile/app-root-provenance";
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
  applyAuthoredAppMount,
  applyAuthoredDependencies,
  applyAuthoredHealthcheck,
} from "../planner/authored.ts";
import { attachEffectiveEvents, effectiveEventsForPlan } from "../planner/effective-events.ts";
import { attachEffectiveTooling, effectiveToolingForPlan } from "../planner/effective-tooling.ts";
import { FILE_SYNC_DEFAULT_EXCLUDES, mergeDefaultExcludes } from "../planner/file-sync.ts";
import { adoptMysqlVolume } from "../planner/mysql-volume.ts";
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
    const providerRegistry = yield* Effect.serviceOption(RuntimeProviderRegistry);
    const cacheService = yield* Effect.serviceOption(CacheService);
    const configService = yield* Effect.serviceOption(ConfigService);
    const fileSystem = yield* Effect.serviceOption(FileSystem);
    const pathsService = yield* Effect.serviceOption(PathsService);
    const processRunner = yield* Effect.serviceOption(ProcessRunner);
    const certificateAuthorityResolver = yield* Effect.serviceOption(CertificateAuthorityResolver);
    return {
      plan: (landofile, providerCapabilities) =>
        resolveAppIdentity(
          getLandofileAppRoot(landofile) ?? process.cwd(),
          Option.getOrUndefined(processRunner),
        ).pipe(
          Effect.flatMap((identity) =>
            planApp(
              pluginRegistry,
              Option.getOrUndefined(cacheService),
              Option.getOrUndefined(configService),
              Option.getOrUndefined(fileSystem),
              Option.getOrUndefined(pathsService),
              Option.getOrUndefined(certificateAuthorityResolver),
              landofile,
              providerCapabilities,
            ).pipe(
              Effect.flatMap((plan) => {
                const identified = { ...plan, root: identity.appRoot, identity };
                const tooling = effectiveToolingForPlan(plan);
                const events = effectiveEventsForPlan(plan);
                return adoptMysqlVolume(identified, Option.getOrUndefined(providerRegistry)).pipe(
                  Effect.map((adopted) => {
                    if (tooling !== undefined) attachEffectiveTooling(adopted, tooling);
                    if (events !== undefined) attachEffectiveEvents(adopted, events);
                    return adopted;
                  }),
                );
              }),
            ),
          ),
        ),
    } satisfies Context.Tag.Service<typeof AppPlanner>;
  }),
);
