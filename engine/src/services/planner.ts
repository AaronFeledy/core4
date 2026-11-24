import { mapFailures } from "@lando/sdk/command-result";
import { LandofileValidationError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { AppPlanner, PathsService, type PluginRegistry, ProcessRunner } from "@lando/sdk/services";
import { type Context, Effect, Layer, Option } from "effect";
import { canonicalMissingAppRoot } from "../operations/app-mutation-lock.ts";

import { resolveAppIdentity } from "../planner/app-identity.ts";
import { planApp } from "../planner/assemble.ts";
import {
  applyAuthoredDependencies,
  applyAuthoredHealthcheck,
  validateAuthoredAppMount,
} from "../planner/authored.ts";
import { readAppDataIdentity } from "../planner/data-identity.ts";
import { DEFAULT_PROXY_DOMAIN } from "../planner/naming.ts";
import { FileSyncPolicy } from "../plugins/file-sync-policy.ts";

export { AppPlanner } from "@lando/sdk/services";
export {
  DEFAULT_PROXY_DOMAIN,
  applyAuthoredDependencies,
  applyAuthoredHealthcheck,
  validateAuthoredAppMount,
};

export const layer = Layer.effect(
  AppPlanner,
  Effect.gen(function* () {
    const processRunner = yield* Effect.serviceOption(ProcessRunner);
    const paths = yield* PathsService;
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
        const dataRoot = yield* canonicalMissingAppRoot(paths.roots.userDataRoot).pipe(
          mapFailures(
            () =>
              new LandofileValidationError({
                message: `Cannot establish ownership for Lando data root ${paths.roots.userDataRoot}.`,
                remediation:
                  "Make the Lando data root and its parent directories accessible before planning.",
                file: landofile.context.appRoot,
                issues: [],
              }),
          ),
        );
        const plannedIdentity = { ...identity, dataName, dataRoot: AbsolutePath.make(dataRoot) };
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
