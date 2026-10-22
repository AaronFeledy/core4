import { Effect } from "effect";
import type { GlobalTeardown } from "./global-teardown.ts";
import { tearDownOrphans } from "./orphan-teardown.ts";
import { ownedCleanupChanged, prepareOwnedResourceCleanupFrom } from "./owned-resource-teardown.ts";

export const removeGlobalResources = Effect.fn("GlobalApp.removeResources")(function* (
  resolved: GlobalTeardown,
  options: { readonly volumes: boolean; readonly removeState: boolean },
) {
  const cleanup = yield* prepareOwnedResourceCleanupFrom(
    resolved.evidence.kind === "absent" ? [] : (resolved.evidence.ownership ?? []),
    resolved.paths.root,
    options,
  );
  const result = yield* Effect.gen(function* () {
    switch (resolved.evidence.kind) {
      case "applied": {
        const plan = resolved.evidence.plan;
        const result = yield* resolved.provider.destroy({ app: plan.id, plan }, options);
        switch (result.kind) {
          case "no-op":
            return { changed: false, services: [], volumesRemoved: false };
          case "destroyed":
            return {
              changed: true,
              services: Object.values(plan.services)
                .reverse()
                .map((service) => String(service.name)),
              volumesRemoved: options.volumes,
            };
          default:
            return result satisfies never;
        }
      }
      case "orphans": {
        const result = yield* tearDownOrphans({
          root: resolved.paths.root,
          groups: resolved.evidence.groups,
          options: { volumes: options.volumes, purgeCaches: false },
          ownedCleanup: cleanup,
        });
        return {
          changed: result.services.length > 0 || result.volumesRemoved || result.ownedChanged,
          services: result.services,
          volumesRemoved: result.volumesRemoved,
        };
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
  return {
    changed: result.changed || ownedCleanupChanged(removed),
    services: [...new Set([...result.services, ...removed.servicesRemoved])],
    volumesRemoved: result.volumesRemoved || removed.volumesRemoved > 0,
  };
});
