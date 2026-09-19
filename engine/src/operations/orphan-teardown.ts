import { DateTime, Effect } from "effect";

import type {
  NoProviderInstalledError,
  ProviderConfigError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import type { AbsolutePath, AppPlan } from "@lando/sdk/schema";
import { type AppliedOrphanGroup, type ProviderError, RuntimeProviderRegistry } from "@lando/sdk/services";

export interface OrphanTeardownOptions {
  /** Remove the data volumes recorded against the root; `stop` never does. */
  readonly removeVolumes: boolean;
}

export interface OrphanTeardownResult {
  readonly app: string;
  readonly services: ReadonlyArray<string>;
  readonly volumesRemoved: boolean;
}

export type OrphanTeardownError =
  | ProviderError
  | ProviderUnavailableError
  | ProviderConfigError
  | NoProviderInstalledError;

const now = () => DateTime.unsafeMake(new Date().toISOString());

/**
 * `RuntimeProviderRegistry.select` resolves a provider from `plan.provider` alone, and an orphan
 * group has no plan left to pass. This carries the observed provider and app identity and nothing
 * else, so it can never be mistaken for a plan that describes resources.
 */
const selectionPlan = (group: AppliedOrphanGroup, root: AbsolutePath): AppPlan => ({
  id: group.appId,
  name: String(group.appId),
  slug: String(group.appId),
  root,
  provider: group.providerId,
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: { resolvedAt: now(), source: "orphan-teardown", runtime: 4 },
  extensions: {},
});

/**
 * Removes the runtime resources recorded against an app root that no applied plan accounts for.
 * Containers go through the provider's own app teardown, which resolves the plan it still holds;
 * data volumes are removed by observed identity so the caller can report exactly what went away.
 */
export const tearDownOrphans = (input: {
  readonly root: AbsolutePath;
  readonly groups: ReadonlyArray<AppliedOrphanGroup>;
  readonly options: OrphanTeardownOptions;
}): Effect.Effect<OrphanTeardownResult, OrphanTeardownError, RuntimeProviderRegistry> =>
  Effect.gen(function* () {
    const registry = yield* RuntimeProviderRegistry;
    const services: string[] = [];
    let volumesRemoved = false;
    for (const group of input.groups) {
      const provider = yield* registry.select(selectionPlan(group, input.root));
      if (group.services.length > 0) {
        // App ids are not unique across roots, so provider state is never forgotten by id here:
        // the record this teardown targets was already unmatched, and another root may hold the id.
        yield* provider.destroy({ app: group.appId }, { volumes: false, removeState: false });
        services.push(...group.services.map((service) => String(service.service)));
      }
      if (!input.options.removeVolumes) continue;
      for (const volume of group.volumes) {
        const generation = volume.identity?.generation;
        if (generation === undefined) continue;
        yield* provider.removeVolume(volume.ref, generation);
        volumesRemoved = true;
      }
    }
    return {
      app: String(input.groups[0]?.appId ?? ""),
      services,
      volumesRemoved,
    };
  });
