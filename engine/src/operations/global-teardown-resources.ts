import {
  type ContainerBringDownReceipt,
  type ServiceShutdownObservation,
  type VolumeRemovalCounts,
  addVolumeRemovalCounts,
  noVolumesRemoved,
  volumesRemovedAny,
} from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import type { GlobalTeardown } from "./global-teardown.ts";
import { tearDownOrphans } from "./orphan-teardown.ts";
import { ownedCleanupChanged, prepareOwnedResourceCleanupFrom } from "./owned-resource-teardown.ts";
import { withShutdownObservations } from "./shutdown-observations.ts";
import { stopUnplannedContainers } from "./stop-unplanned.ts";

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

type GlobalStopReceipt = {
  readonly changed: boolean;
  readonly services: ReadonlyArray<string>;
  readonly volumesRemoved: VolumeRemovalCounts;
  readonly containers: ReadonlyArray<ContainerBringDownReceipt>;
  readonly shutdownObservations?: readonly ServiceShutdownObservation[];
};

const stopReceipt = (
  containers: ReadonlyArray<ContainerBringDownReceipt>,
  ...observations: Array<readonly ServiceShutdownObservation[] | undefined>
): GlobalStopReceipt => {
  const services = containers.flatMap((container) =>
    container.action === "stopped" ? [String(container.service)] : [],
  );
  return withShutdownObservations(
    {
      changed: services.length > 0,
      services: [...new Set(services)],
      volumesRemoved: { ...noVolumesRemoved },
      containers,
    },
    ...observations,
  );
};

/**
 * Stops the global app's containers and keeps them with their networks, volumes, applied state, and
 * ownership inventory, so pending container-removal obligations stay pending for a later destroy.
 */
export const stopGlobalResources = Effect.fn("GlobalApp.stopResources")(function* (resolved: GlobalTeardown) {
  switch (resolved.evidence.kind) {
    case "applied": {
      const plan = resolved.evidence.plan;
      const stopped = yield* resolved.provider.bringDown({ app: plan.id, plan }, { containers: "stop" });
      const unplanned = yield* stopUnplannedContainers(plan, resolved.provider);
      switch (stopped.kind) {
        case "stopped":
        case "removed":
          return stopReceipt(
            [...stopped.containers, ...unplanned.containers],
            stopped.shutdownObservations,
            unplanned.shutdownObservations,
          );
        case "no-op":
          return stopReceipt(
            unplanned.containers,
            stopped.shutdownObservations,
            unplanned.shutdownObservations,
          );
        default:
          return stopped satisfies never;
      }
    }
    case "orphans": {
      // No plan accounts for these containers, so each is stopped by the identity the provider observed.
      const registry = yield* RuntimeProviderRegistry;
      const containers: ContainerBringDownReceipt[] = [];
      const observations: Array<readonly ServiceShutdownObservation[] | undefined> = [];
      for (const group of resolved.evidence.groups) {
        const provider = yield* registry.select(group.providerId);
        for (const service of group.services) {
          const { shutdownObservations, ...receipt } = yield* provider.bringDownObserved(service, "stop");
          containers.push(receipt);
          observations.push(shutdownObservations);
        }
      }
      return stopReceipt(containers, ...observations);
    }
    case "owned":
    case "absent":
      return stopReceipt([]);
    default:
      return resolved.evidence satisfies never;
  }
});
