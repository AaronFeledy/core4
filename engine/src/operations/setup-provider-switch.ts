import { AppPlacementError, ProviderUnavailableError } from "@lando/sdk/errors";
import { type AppPlan, AppRef, type ProviderId } from "@lando/sdk/schema";
import { GlobalAppService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { resolveAppPlacement } from "../providers/app-placement.ts";
import { matchesAppPlanIdentity } from "../providers/app-plan-identity.ts";
import { SCRATCH_EXTENSION_KEY } from "../scratch-app/identity.ts";
import { missingRootAppliedTarget } from "./applied-state-target.ts";
import { prepareOwnedResourceCleanupFrom } from "./owned-resource-teardown.ts";

export const SetupProviderSwitchResultSchema = Schema.Struct({
  fromProviderId: Schema.String,
  toProviderId: Schema.String,
  remainingApps: Schema.Array(AppRef),
});
export type SetupProviderSwitchResult = typeof SetupProviderSwitchResultSchema.Type;

const appRef = (plan: AppPlan): AppRef => ({
  kind: Object.hasOwn(plan.extensions, SCRATCH_EXTENSION_KEY) ? "scratch" : "user",
  id: plan.id,
  root: plan.identity?.appRoot ?? plan.root,
});

export const switchGlobalProviderForSetup = Effect.fn("Setup.switchGlobalProvider")(function* (
  selected: ProviderId,
) {
  const globalApp = yield* Effect.serviceOption(GlobalAppService);
  if (globalApp._tag === "None") return undefined;
  const paths = yield* globalApp.value.paths;
  const app = { kind: "global" as const, id: "global", root: paths.root };
  const placement = yield* resolveAppPlacement(app, selected);
  const plan = placement.plan;
  if (plan === undefined || plan.provider === selected) return undefined;
  yield* missingRootAppliedTarget(plan, plan.identity?.appRoot ?? plan.root);

  const registry = yield* RuntimeProviderRegistry;
  const provider = yield* registry.select(plan.provider);
  if (provider.appliedPlans === undefined || !(yield* provider.isAvailable))
    return yield* Effect.fail(
      new ProviderUnavailableError({
        providerId: plan.provider,
        operation: "setup-switch",
        message: "Cannot verify apps on the previous global provider before switching.",
        remediation: `Restore ${plan.provider}, run \`lando poweroff --yes\`, then retry setup.`,
      }),
    );
  const appPlans = (yield* provider.appliedPlans).filter(
    (candidate) =>
      candidate.provider === plan.provider &&
      ((candidate.identity?.appRoot ?? candidate.root) !== (plan.identity?.appRoot ?? plan.root) ||
        !matchesAppPlanIdentity(candidate, app)),
  );
  const services = yield* provider.list({ includeUnplanned: true });
  const runningApps = appPlans
    .filter(
      (candidate) =>
        (candidate.routes.length > 0 || (candidate.requires?.globalServices.length ?? 0) > 0) &&
        services.some(
          (service) =>
            service.app === candidate.id &&
            service.appRoot === (candidate.identity?.appRoot ?? candidate.root) &&
            ["running", "paused", "restarting"].includes(service.state ?? service.status),
        ),
    )
    .map(appRef);
  if (runningApps.length > 0)
    return yield* Effect.fail(
      new AppPlacementError({
        app,
        desiredProviderId: selected,
        realizedProviderId: plan.provider,
        runningApps,
        message: `Cannot switch global services from ${plan.provider} to ${selected}; dependent apps are running: ${runningApps.map((entry) => `${entry.id} (${entry.root})`).join(", ")}.`,
        remediation: `Run \`lando poweroff --yes\`, or stop each dependent: ${runningApps
          .map((entry) =>
            entry.kind === "scratch"
              ? `\`lando scratch:destroy ${entry.id} --keep-volumes --yes\``
              : `\`lando stop\` from ${entry.root}`,
          )
          .join("; ")}. Then retry setup.`,
      }),
    );

  const root = plan.identity?.appRoot ?? plan.root;
  const ownership = yield* registry.resourceOwnership?.(plan.provider, root) ?? Effect.succeed(undefined);
  const options = { volumes: false, removeState: true };
  const cleanup = yield* prepareOwnedResourceCleanupFrom(
    ownership === undefined ? [] : [ownership],
    root,
    options,
  );
  yield* provider.destroy({ app: plan.id, plan }, options);
  yield* cleanup;
  return {
    fromProviderId: plan.provider,
    toProviderId: selected,
    remainingApps: appPlans
      .filter((candidate) => matchesAppPlanIdentity(candidate, { kind: "user", id: "" }))
      .map(appRef),
  } satisfies SetupProviderSwitchResult;
});
