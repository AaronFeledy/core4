import type { ServiceShutdownObservation } from "@lando/sdk/schema";
import { Effect } from "effect";
import type { GlobalTeardown } from "./global-teardown.ts";
import { tearDownOrphans } from "./orphan-teardown.ts";
import { ownedCleanupChanged, prepareOwnedResourceCleanupFrom } from "./owned-resource-teardown.ts";
import { withShutdownObservations } from "./shutdown-observations.ts";

type GlobalResourceReceipt = {
  readonly changed: boolean;
  readonly services: ReadonlyArray<string>;
  readonly volumesRemoved: boolean;
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
        const destroyed = yield* resolved.provider.destroy({ app: plan.id, plan }, options);
        switch (destroyed.kind) {
          case "no-op":
            return withShutdownObservations(
              { changed: false, services: [] as string[], volumesRemoved: false },
              destroyed.shutdownObservations,
            );
          case "destroyed":
            return withShutdownObservations(
              {
                changed: true,
                services: Object.values(plan.services)
                  .reverse()
                  .map((service) => String(service.name)),
                volumesRemoved: options.volumes,
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
            changed: removed.services.length > 0 || removed.volumesRemoved || removed.ownedChanged,
            services: removed.services,
            volumesRemoved: removed.volumesRemoved,
          },
          removed.shutdownObservations,
        );
      }
      case "owned":
      case "absent":
        return { changed: false, services: [], volumesRemoved: false };
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
      volumesRemoved: result.volumesRemoved || removed.volumesRemoved > 0,
    },
    result.shutdownObservations,
  );
});
