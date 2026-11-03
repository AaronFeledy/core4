import { Effect } from "effect";

import type { AppPlan } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";

import { staleClonedServices } from "../planner/cloned-services.ts";

/** Stop leftover `addClonedService` companions before start/rebuild apply. */
export const removeStaleClonedServices = Effect.fn("AppOperation.removeStaleClonedServices")(function* (
  desired: AppPlan,
) {
  const registry = yield* RuntimeProviderRegistry;
  const applied = yield* registry.resolveAppliedPlan(desired.root);
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
