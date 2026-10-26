import { AppPlacementError, AppResolveError } from "@lando/sdk/errors";
import { AbsolutePath, type AppPlan, type AppRef, type ProviderId } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Context, Effect } from "effect";
import { canonicalMissingAppRoot } from "../operations/app-mutation-lock.ts";
import { matchesAppPlanIdentity } from "./app-plan-identity.ts";

export const TeardownProvider = Context.Reference<ProviderId | undefined>("@lando/engine/TeardownProvider", {
  defaultValue: () => undefined,
});

const destroyCommand = (app: AppRef, provider: ProviderId): string => {
  switch (app.kind) {
    case "global":
      return `lando global:destroy --provider=${provider} --yes`;
    case "scratch":
      return `lando scratch:destroy ${app.id} --keep-volumes --yes`;
    case "user":
      return `lando destroy --provider=${provider} --yes`;
  }
};

/** Applied plans claim placement; inventories alone do not. This never contacts a runtime. */
export const resolveAppPlacement = Effect.fn("AppPlacement.resolve")(function* (
  app: AppRef,
  desired: ProviderId,
  providerId?: ProviderId,
) {
  const root = AbsolutePath.make(yield* canonicalMissingAppRoot(app.root));
  const registry = yield* RuntimeProviderRegistry;
  const plans = (yield* registry.appliedPlansFor(root)).filter(
    (plan) => (providerId === undefined || plan.provider === providerId) && matchesAppPlanIdentity(plan, app),
  );
  if (plans.length > 1)
    return yield* Effect.fail(
      new AppResolveError({
        message: `App ${app.id} has multiple applied plans on providers: ${plans.map((plan) => plan.provider).join(", ")}.`,
        reason: "ambiguous",
        detail: "provider-resources",
        remediation: `From ${root}, remove each unwanted realization explicitly: ${[...new Set(plans.map((plan) => plan.provider))].map((provider) => `\`${destroyCommand(app, provider)}\``).join("; ")}. Then retry.`,
      }),
    );
  return { desired, realized: plans[0]?.provider, plan: plans[0] };
});

export const ensureAppPlacement = Effect.fn("AppPlacement.ensure")(function* (
  app: AppRef,
  desired: ProviderId,
) {
  const placement = yield* resolveAppPlacement(app, desired);
  const realized = placement.realized;
  if (realized !== undefined && realized !== desired)
    return yield* Effect.fail(
      new AppPlacementError({
        app,
        desiredProviderId: desired,
        realizedProviderId: realized,
        message: `App ${app.id} runs on ${realized}, but creation selects ${desired}.`,
        remediation: `From ${app.root}, run \`${destroyCommand(app, realized)}\` before starting on ${desired}. To keep the existing realization, select ${realized} instead.`,
      }),
    );
  return desired;
});

export const observedAppPlan = Effect.fn("AppPlacement.observedPlan")(function* (plan: AppPlan) {
  const placement = yield* resolveAppPlacement({ kind: "user", id: plan.id, root: plan.root }, plan.provider);
  return placement.plan ?? plan;
});
