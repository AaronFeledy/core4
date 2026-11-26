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
import { isUnsafeScratchId, scratchPathsFor } from "../scratch-app/identity.ts";

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
        const kind = options?.kind ?? "user";
        const projectRoot = landofile.context.appRoot;
        const scratchName = landofile.document.name;
        const scratchId =
          kind === "scratch" && scratchName !== undefined && !isUnsafeScratchId(scratchName)
            ? scratchName
            : undefined;
        if (kind === "scratch" && scratchId === undefined)
          return yield* Effect.fail(
            new LandofileValidationError({
              message: "Cannot plan a scratch app without a safe scratch id.",
              remediation:
                "Acquire the scratch through `lando scratch:start` so Lando can name its instance.",
              file: projectRoot,
              issues: [],
            }),
          );
        const ownerRoot =
          scratchId === undefined ? projectRoot : String(scratchPathsFor(paths.scratchDir, scratchId).root);
        const identity = yield* resolveAppIdentity(
          ownerRoot,
          kind === "scratch" ? undefined : Option.getOrUndefined(processRunner),
        );
        const projectCoordinate =
          kind === "scratch" ? (yield* resolveAppIdentity(projectRoot, undefined)).appRoot : identity.appRoot;
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
          appRoot: projectCoordinate,
          dataName,
          kind,
          identity: plannedIdentity,
        }).pipe(Effect.provide(context), Effect.provideService(FileSyncPolicy, policy));
        return { ...plan, root: identity.appRoot, identity: plannedIdentity };
      }),
    } satisfies Context.Service.Shape<typeof AppPlanner>);
  }),
);
