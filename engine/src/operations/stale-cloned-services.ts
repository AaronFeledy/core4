import { Effect } from "effect";

import type { AppPlan } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";

import { staleClonedServices } from "../planner/cloned-services.ts";

/**
 * Stop leftover `addClonedService` companions before start/rebuild apply.
 * Reads filesystem applied plans, not `resolveAppliedPlan`, so a failed apply
 * that left orphan runtime resources can still retry start.
 */
export const removeStaleClonedServices = Effect.fn("AppOperation.removeStaleClonedServices")(function* (
  desired: AppPlan,
) {
  const registry = yield* RuntimeProviderRegistry;
  const appliedPlans = yield* registry.appliedPlansFor(desired.root);
  const applied =
    appliedPlans.find((candidate) => candidate.provider === desired.provider) ?? appliedPlans[0];
  if (applied === undefined) return;
  const stale = staleClonedServices(applied, desired);
  if (stale.length === 0) return;
  const provider = yield* registry.select(applied);
  yield* Effect.forEach(
    [...stale].reverse(),
    (service) => provider.stop({ app: applied.id, service: service.name, plan: applied }),
    { discard: true },
  );
});
