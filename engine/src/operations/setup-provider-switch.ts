import { AppPlacementError, ProviderUnavailableError } from "@lando/sdk/errors";
import { type AppPlan, AppRef, type ProviderId } from "@lando/sdk/schema";
import { GlobalAppService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { resolveAppPlacement } from "../providers/app-placement.ts";
import { missingRootAppliedTarget } from "./applied-state-target.ts";
import { prepareOwnedResourceCleanupFrom } from "./owned-resource-teardown.ts";

export const SetupProviderSwitchResultSchema = Schema.Struct({
  fromProviderId: Schema.String,
  toProviderId: Schema.String,
  remainingApps: Schema.Array(AppRef),
});
export type SetupProviderSwitchResult = typeof SetupProviderSwitchResultSchema.Type;

const userRef = (plan: AppPlan): AppRef => ({
  kind: "user",
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
  const userPlans = (yield* provider.appliedPlans).filter(
    (candidate) =>
      candidate.provider === plan.provider &&
      (candidate.identity?.appRoot ?? candidate.root) !== (plan.identity?.appRoot ?? plan.root) &&
      !Object.hasOwn(candidate.extensions, "@lando/core/scratch"),
  );
  const services = yield* provider.list({ includeUnplanned: true });
  const runningApps = userPlans
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
    .map(userRef);
  if (runningApps.length > 0)
    return yield* Effect.fail(
      new AppPlacementError({
        app,
        desiredProviderId: selected,
        realizedProviderId: plan.provider,
        runningApps,
        message: `Cannot switch global services from ${plan.provider} to ${selected}; dependent apps are running: ${runningApps.map((entry) => `${entry.id} (${entry.root})`).join(", ")}.`,
        remediation:
          "Run `lando poweroff --yes`, or run `lando stop` in each listed app directory, then retry setup.",
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
    remainingApps: userPlans.map(userRef),
  } satisfies SetupProviderSwitchResult;
});
