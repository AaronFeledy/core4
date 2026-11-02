import { type Context, Effect, Layer, Option } from "effect";

import { AppPlanner, type PluginRegistry, ProcessRunner, RuntimeProviderRegistry } from "@lando/sdk/services";

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
import { FileSyncPolicy } from "../plugins/file-sync-policy.ts";

export { AppPlanner } from "@lando/sdk/services";
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
    const providerRegistry = yield* Effect.serviceOption(RuntimeProviderRegistry);
    const processRunner = yield* Effect.serviceOption(ProcessRunner);
    const policy = yield* FileSyncPolicy.make;
    const context = yield* Effect.context<PluginRegistry>();
    return AppPlanner.of({
      plan: Effect.fn("AppPlanner.plan")(function* (landofile, providerCapabilities) {
        const identity = yield* resolveAppIdentity(
          landofile.context.appRoot,
          Option.getOrUndefined(processRunner),
        );
        const plan = yield* planApp({ landofile, providerCapabilities, appRoot: identity.appRoot }).pipe(
          Effect.provide(context),
          Effect.provideService(FileSyncPolicy, policy),
        );
        const identified = { ...plan, root: identity.appRoot, identity };
        return yield* adoptMysqlVolume(identified, Option.getOrUndefined(providerRegistry));
      }),
    } satisfies Context.Service.Shape<typeof AppPlanner>);
  }),
);
