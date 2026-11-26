import {
  type AppPlan,
  type ContainerBringDownReceipt,
  type ServiceShutdownObservation,
  isIdleRunStatus,
} from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { Effect } from "effect";

import { mergeShutdownObservations } from "./shutdown-observations.ts";
import { ownedContainers } from "./stop-selection.ts";

/** What stopping an app's owned containers outside its plan did. */
export type StoppedUnplanned = {
  readonly containers: readonly ContainerBringDownReceipt[];
  readonly shutdownObservations?: readonly ServiceShutdownObservation[];
};

/**
 * Stops this app's owned containers whose service the plan does not name, such as one a failed
 * start left or one for a service the Landofile dropped before its removal finished. A planful
 * `bringDown` reaches only planned services, so these would keep running after a whole-app stop.
 * Idle ones have nothing to stop and are left alone; every container is kept.
 */
export const stopUnplannedContainers = Effect.fn("AppOperation.stopUnplannedContainers")(function* (
  plan: AppPlan,
  provider: Pick<RuntimeProviderShape, "list" | "bringDownObserved">,
) {
  const observed = yield* provider.list({ app: plan.id, includeUnplanned: true });
  const containers: ContainerBringDownReceipt[] = [];
  const observations: Array<readonly ServiceShutdownObservation[] | undefined> = [];
  for (const row of ownedContainers(plan, observed)) {
    if (Object.hasOwn(plan.services, row.service) || isIdleRunStatus(row.status)) continue;
    const { shutdownObservations, ...receipt } = yield* provider.bringDownObserved(row, "stop");
    observations.push(shutdownObservations);
    containers.push(receipt);
  }
  const shutdownObservations = mergeShutdownObservations(...observations);
  return (
    shutdownObservations === undefined ? { containers } : { containers, shutdownObservations }
  ) satisfies StoppedUnplanned;
});
