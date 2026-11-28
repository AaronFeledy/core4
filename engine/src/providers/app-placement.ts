import { engineEndpointDisplay } from "@lando/container-runtime/engine-identity";
import { AppPlacementError, AppResolveError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type AppRef,
  type AppliedAppPlan,
  type ProviderId,
} from "@lando/sdk/schema";
import { RuntimeProviderRegistry, type RuntimeProviderShape } from "@lando/sdk/services";
import { Context, Effect } from "effect";
import { canonicalMissingAppRoot } from "../operations/app-mutation-lock.ts";
import { matchesAppPlanIdentity } from "./app-plan-identity.ts";

export const TeardownProvider = Context.Reference<ProviderId | undefined>("@lando/engine/TeardownProvider", {
  defaultValue: () => undefined,
});

export const destroyCommand = (app: Pick<AppRef, "kind" | "id">, provider: ProviderId): string => {
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
  observe = false,
) {
  const root = AbsolutePath.make(yield* canonicalMissingAppRoot(app.root));
  const registry = yield* RuntimeProviderRegistry;
  const discovered = yield* registry.appliedPlansFor(root, {
    ...(providerId === undefined ? {} : { providerId }),
    ...(observe ? { observe: true } : {}),
  });
  const plans = discovered.filter(
    (plan) =>
      (plan.identity?.appRoot ?? plan.root) === root &&
      (providerId === undefined || plan.provider === providerId) &&
      matchesAppPlanIdentity(plan, app),
  );
  const current = app.kind === "user" ? plans.filter((plan) => plan.id === app.id) : plans;
  const superseded = app.kind === "user" ? plans.filter((plan) => plan.id !== app.id) : [];
  const providers = [...new Set(plans.map((plan) => plan.provider))];
  if (current.length > 1 || (app.kind !== "user" && providers.length > 1))
    return yield* Effect.fail(
      new AppResolveError({
        message: `App ${app.id} has multiple applied plans on providers: ${providers.join(", ")}.`,
        reason: "ambiguous",
        detail: "provider-resources",
        remediation: `From ${root}, remove each unwanted realization explicitly: ${providers.map((provider) => `\`${destroyCommand(app, provider)}\``).join("; ")}. Then retry.`,
      }),
    );
  return {
    desired,
    realized: plans.find((plan) => plan.provider !== desired)?.provider ?? providers[0],
    plan: current[0],
    superseded,
  };
});

export const ensureAppPlacementState = Effect.fn("AppPlacement.ensureState")(function* (
  app: AppRef,
  desired: ProviderId,
) {
  const registry = yield* RuntimeProviderRegistry;
  if (app.kind !== "global")
    yield* registry.readAppliedPlanStrict({ id: AppId.make(app.id), provider: desired });
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
  return placement;
});

export const ensureAppPlacement = Effect.fn("AppPlacement.ensure")(function* (
  app: AppRef,
  desired: ProviderId,
) {
  return (yield* ensureAppPlacementState(app, desired)).desired;
});

export const requireOwningEngine = (
  provider: RuntimeProviderShape,
  kind: AppRef["kind"],
  plans: readonly (Pick<AppliedAppPlan, "id" | "provider" | "root" | "engineIdentity"> | undefined)[],
) => {
  const current = provider.engineIdentity;
  if (current === undefined) return Effect.void;
  for (const plan of plans) {
    if (plan === undefined || plan.provider !== provider.id) continue;
    const recorded = plan.engineIdentity;
    if (recorded === undefined || recorded.fingerprint === current.fingerprint) continue;
    const app = { kind, root: plan.root, id: plan.id };
    const owningEndpoint = engineEndpointDisplay(recorded.endpoint);
    return Effect.fail(
      new AppPlacementError({
        app,
        desiredProviderId: provider.id,
        realizedProviderId: plan.provider,
        message: `App ${plan.id} was realized at ${owningEndpoint}, but ${engineEndpointDisplay(current.endpoint)} now connects to a different engine.`,
        remediation: `Restore the connection to ${owningEndpoint}${provider.id === "docker" ? " with `docker context use <name>` or by setting DOCKER_HOST" : " by setting DOCKER_HOST"}. To retire the old realization, reconnect to its engine and run \`${destroyCommand(app, plan.provider)}\`.`,
      }),
    );
  }
  return Effect.void;
};

export const observedAppPlan = Effect.fn("AppPlacement.observedPlan")(function* (
  plan: AppPlan,
  observe = false,
) {
  const placement = yield* resolveAppPlacement(
    { kind: "user", id: plan.id, root: plan.root },
    plan.provider,
    undefined,
    observe,
  );
  return placement.plan ?? plan;
});
