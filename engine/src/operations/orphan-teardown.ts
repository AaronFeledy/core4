import { DateTime, Effect } from "effect";

import type {
  AppLockTimeoutError,
  NoProviderInstalledError,
  ProviderConfigError,
  ProviderUnavailableError,
  StateStoreError,
} from "@lando/sdk/errors";
import type { AbsolutePath, AppPlan } from "@lando/sdk/schema";
import {
  type AppliedOrphanGroup,
  type PathsService,
  type ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { appLockTarget, withAppMutationLock } from "./app-mutation-lock.ts";

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
  | NoProviderInstalledError
  | AppLockTimeoutError
  | StateStoreError;

const now = () => DateTime.unsafeMake(new Date().toISOString());

/**
 * `RuntimeProviderRegistry.select` resolves a provider from `plan.provider` alone, and an orphan
 * group has no applied plan left. This carries the observed provider, app id, and teardown root so
 * destroy cannot fall back to another project's applied plan for the same app id. Empty `services`
 * means it never describes resources; volume removal stays on observed identity.
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
 * Container teardown is handed a root-scoped selection plan so providers never look up applied
 * state by app id; data volumes are removed by observed identity so the caller can report exactly
 * what went away.
 */
export const tearDownOrphans = (input: {
  readonly root: AbsolutePath;
  readonly groups: ReadonlyArray<AppliedOrphanGroup>;
  readonly options: OrphanTeardownOptions;
}): Effect.Effect<
  OrphanTeardownResult,
  OrphanTeardownError,
  RuntimeProviderRegistry | PathsService | PrivateFileAccessService
> =>
  Effect.gen(function* () {
    const registry = yield* RuntimeProviderRegistry;
    const services: string[] = [];
    let volumesRemoved = false;
    for (const group of input.groups) {
      const plan = selectionPlan(group, input.root);
      yield* withAppMutationLock(
        appLockTarget(plan),
        Effect.gen(function* () {
          const provider = yield* registry.select(plan);
          if (group.services.length > 0) {
            // App ids are not unique across roots, so never forget provider state by id.
            yield* provider.destroy({ app: group.appId, plan }, { volumes: false, removeState: false });
            services.push(...group.services.map((service) => String(service.service)));
          }
          if (!input.options.removeVolumes) return;
          for (const volume of group.volumes) {
            const generation = volume.identity?.generation;
            if (generation === undefined) continue;
            yield* provider.removeVolume(volume.ref, generation);
            volumesRemoved = true;
          }
        }),
      );
    }
    return {
      app: String(input.groups[0]?.appId ?? ""),
      services,
      volumesRemoved,
    };
  });
