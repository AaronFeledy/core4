import {
  type ServiceShutdownObservation,
  type VolumeRemovalCounts,
  addVolumeRemovalCounts,
  noVolumesRemoved,
  volumesRemovedAny,
} from "@lando/sdk/schema";
import { Effect } from "effect";
import type { GlobalTeardown } from "./global-teardown.ts";
import { tearDownOrphans } from "./orphan-teardown.ts";
import { ownedCleanupChanged, prepareOwnedResourceCleanupFrom } from "./owned-resource-teardown.ts";
import { withShutdownObservations } from "./shutdown-observations.ts";

type GlobalResourceReceipt = {
  readonly changed: boolean;
  readonly services: ReadonlyArray<string>;
  readonly volumesRemoved: VolumeRemovalCounts;
  readonly shutdownObservations?: readonly ServiceShutdownObservation[];
};

export const removeGlobalResources = Effect.fn("GlobalApp.removeResources")(function* (
  resolved: GlobalTeardown,
  options: { readonly volumes: boolean; readonly removeState: boolean },
) {
  const cleanup = yield* prepareOwnedResourceCleanupFrom(
    resolved.evidence.kind === "absent" ? [] : (resolved.evidence.ownership ?? []),
    resolved.paths.root,
    options,
  );
  const result: GlobalResourceReceipt = yield* Effect.gen(function* () {
    switch (resolved.evidence.kind) {
      case "applied": {
        const plan = resolved.evidence.plan;
        const destroyed = yield* resolved.provider.bringDown(
          { app: plan.id, plan },
          { containers: "remove", ...options },
        );
        switch (destroyed.kind) {
          case "stopped":
          case "no-op":
            return withShutdownObservations(
              { changed: false, services: [] as string[], volumesRemoved: { ...noVolumesRemoved } },
              destroyed.shutdownObservations,
            );
          case "removed":
            return withShutdownObservations(
              {
                changed: true,
                services: Object.values(plan.services)
                  .reverse()
                  .map((service) => String(service.name)),
                volumesRemoved: destroyed.volumesRemoved,
              },
              destroyed.shutdownObservations,
            );
          default:
            return destroyed satisfies never;
        }
      }
      case "orphans": {
        const removed = yield* tearDownOrphans({
          root: resolved.paths.root,
          groups: resolved.evidence.groups,
          options: { volumes: options.volumes, purgeCaches: false },
          ownedCleanup: cleanup,
        });
        return withShutdownObservations(
          {
            changed:
              removed.services.length > 0 ||
              volumesRemovedAny(removed.volumesRemoved) ||
              removed.ownedChanged,
            services: removed.services,
            volumesRemoved: removed.volumesRemoved,
          },
          removed.shutdownObservations,
        );
      }
      case "owned":
      case "absent":
        return { changed: false, services: [], volumesRemoved: { ...noVolumesRemoved } };
      default:
        return resolved.evidence satisfies never;
    }
  });
  if (resolved.evidence.kind === "orphans") return result;
  const removed = yield* cleanup;
  return withShutdownObservations(
    {
      changed: result.changed || ownedCleanupChanged(removed),
      services: [...new Set([...result.services, ...removed.servicesRemoved])],
      volumesRemoved: addVolumeRemovalCounts(result.volumesRemoved, removed.volumesRemoved),
    },
    result.shutdownObservations,
  );
});
