import { AppPlanner, type PluginRegistry, ProcessRunner } from "@lando/sdk/services";
import { type Context, Effect, Layer, Option } from "effect";

import { resolveAppIdentity } from "../planner/app-identity.ts";
import { planApp } from "../planner/assemble.ts";
import {
  applyAuthoredDependencies,
  applyAuthoredHealthcheck,
  validateAuthoredAppMount,
} from "../planner/authored.ts";
import { readAppDataIdentity } from "../planner/data-identity.ts";
import { DEFAULT_APP_MOUNT_EXCLUDES, mergeDefaultExcludes } from "../planner/file-sync.ts";
import { DEFAULT_PROXY_DOMAIN } from "../planner/naming.ts";
import { FileSyncPolicy } from "../plugins/file-sync-policy.ts";

export { AppPlanner } from "@lando/sdk/services";
export {
  DEFAULT_APP_MOUNT_EXCLUDES,
  DEFAULT_PROXY_DOMAIN,
  applyAuthoredDependencies,
  applyAuthoredHealthcheck,
  mergeDefaultExcludes,
  validateAuthoredAppMount,
};

export const layer = Layer.effect(
  AppPlanner,
  Effect.gen(function* () {
    const processRunner = yield* Effect.serviceOption(ProcessRunner);
    const policy = yield* FileSyncPolicy.make;
    const context = yield* Effect.context<PluginRegistry>();
    return AppPlanner.of({
      plan: Effect.fn("AppPlanner.plan")(function* (landofile, providerCapabilities, options) {
        const identity = yield* resolveAppIdentity(
          landofile.context.appRoot,
          Option.getOrUndefined(processRunner),
        );
        const kind = options?.kind ?? "user";
        const record =
          kind === "user" ? yield* readAppDataIdentity(identity).pipe(Effect.provide(context)) : null;
        const dataName = options?.dataName ?? record?.name ?? landofile.document.name ?? "app";
        const plannedIdentity = { ...identity, dataName };
        const plan = yield* planApp({
          landofile,
          providerCapabilities,
          appRoot: identity.appRoot,
          dataName,
          kind,
          identity: plannedIdentity,
        }).pipe(Effect.provide(context), Effect.provideService(FileSyncPolicy, policy));
        return { ...plan, root: identity.appRoot, identity: plannedIdentity };
      }),
    } satisfies Context.Service.Shape<typeof AppPlanner>);
  }),
);
