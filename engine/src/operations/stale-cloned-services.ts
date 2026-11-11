import type { AppPlan } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";

import { staleClonedServices } from "../planner/cloned-services.ts";

/**
 * Remove leftover `addClonedService` companions before start/rebuild apply.
 * Reads filesystem applied plans, not `resolveAppliedPlan`, so a failed apply
 * that left orphan runtime resources can still retry start. Stops and removes
 * the observed container so it cannot hold network endpoints after exit.
 */
export const removeStaleClonedServices = Effect.fn("AppOperation.removeStaleClonedServices")(function* (
  desired: AppPlan,
) {
  const registry = yield* RuntimeProviderRegistry;
  const applied = (yield* registry.appliedPlansFor(desired.root)).find(
    (candidate) => candidate.provider === desired.provider,
  );
  if (applied === undefined) return;
  const stale = staleClonedServices(applied, desired);
  if (stale.length === 0) return;
  const provider = yield* registry.select(applied);
  const staleNames = new Set(stale.map((service) => String(service.name)));
  const observed = yield* provider.list({ app: applied.id, includeUnplanned: true });
  yield* Effect.forEach(
    [...observed].reverse().filter((row) => staleNames.has(String(row.service))),
    (row) => provider.removeObservedService(row),
    { discard: true },
  );
});
