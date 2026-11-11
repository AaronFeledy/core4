import { AppDataIdentityError } from "@lando/sdk/errors";
import { type AppPlan, planAppIdentity } from "@lando/sdk/schema";
import { AppPlanner, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import type { ResolvedAppTarget } from "../landofile/app-resolution.ts";
import { readAppDataIdentity } from "../planner/data-identity.ts";

const isUserAppliedPlan = (plan: AppPlan): boolean =>
  plan.id !== "global" && plan.extensions["@lando/core/scratch"] === undefined;

/** Distinct data names carried by same-root user applied plans on any provider. */
const unambiguousAppliedDataName = Effect.fnUntraced(function* (root: AppPlan["root"]) {
  const registry = yield* RuntimeProviderRegistry;
  const applied = yield* registry.appliedPlansFor(root);
  const names = new Set(
    applied
      .filter((plan) => isUserAppliedPlan(plan) && planAppIdentity(plan).appRoot === root)
      .map((plan) => plan.identity?.dataName ?? plan.name),
  );
  return names.size === 1 ? [...names][0] : undefined;
});

/**
 * Under the root mutation lock, before overlays, placement, retirement, preflight, or any mutation:
 * resolve the folder's data name from the durable record, else an unambiguous same-root user applied
 * plan name on any provider, else the target plan's identity.dataName ?? name. When that differs from
 * the target plan's stamped dataName, replan with the explicit dataName and available landofile.
 */
export const reconcileAppDataIdentity = Effect.fn("AppDataIdentity.reconcile")(function* (
  target: ResolvedAppTarget,
) {
  if (target.app.kind !== "user") return target;

  const identity = planAppIdentity(target.plan);
  const record = yield* readAppDataIdentity(identity);
  const dataName =
    record?.name ??
    (yield* unambiguousAppliedDataName(identity.appRoot)) ??
    target.plan.identity?.dataName ??
    target.plan.name;

  // A plan recorded without a data name owns its data under its own name.
  if ((target.plan.identity?.dataName ?? target.plan.name) === dataName) return target;

  const landofile = target.landofile;
  if (landofile === undefined) {
    return yield* Effect.fail(
      new AppDataIdentityError({
        appRoot: identity.appRoot,
        message: `This folder's data is named "${dataName}", but this start request carries a plan without its Landofile, so Lando cannot replan the app under that data name.`,
        remediation: `Start the app from its folder, or pass a target resolved from its Landofile. Its volumes and generated credentials keep the name "${dataName}".`,
      }),
    );
  }

  const planner = yield* AppPlanner;
  const registry = yield* RuntimeProviderRegistry;
  const capabilities = yield* registry.capabilities;
  const plan = yield* planner.plan(landofile, capabilities, { kind: "user", dataName });
  return {
    ...target,
    plan,
    root: plan.root,
    app: { ...target.app, id: plan.id, root: plan.root },
  } satisfies ResolvedAppTarget;
});
