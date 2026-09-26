import { DateTime, Effect } from "effect";

import {
  isGlobalScopedVolume,
  teardownVolumeClasses,
  volumeClassFromLabels,
} from "@lando/container-runtime/volume-classes";
import type { AppLockTimeoutError, StateStoreError } from "@lando/sdk/errors";
import type { AbsolutePath, AppPlan } from "@lando/sdk/schema";
import {
  type AppliedOrphanGroup,
  PathsService,
  type ProviderError,
  type ProviderSelectionError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { cleanupAgentRelayState } from "../subsystems/ssh-agent/cleanup.ts";
import { appLockTarget, withAppMutationLock } from "./app-mutation-lock.ts";

export interface OrphanTeardownOptions {
  /** Remove the data volumes recorded against the root; `stop` never does. */
  readonly volumes: boolean;
  /** Remove the cache volumes recorded against the root; `stop` never does. */
  readonly purgeCaches: boolean;
}

export interface OrphanTeardownResult {
  readonly app: string;
  /** Exactly the services whose container the provider stopped and removed. */
  readonly services: ReadonlyArray<string>;
  readonly volumesRemoved: boolean;
}

export type OrphanTeardownError =
  | ProviderError
  | ProviderSelectionError
  | AppLockTimeoutError
  | StateStoreError;

const now = () => DateTime.unsafeMake(new Date().toISOString());

/**
 * `RuntimeProviderRegistry.select` resolves a provider from `plan.provider` alone, and the app
 * mutation lock is keyed on the app being torn down, so an orphan group still needs a plan-shaped
 * value for both even though no plan survives. It describes no resources: every container and
 * volume here is removed by the identity the provider itself observed.
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
 * Containers and volumes alike go by observed identity, never through provider state looked up by
 * app id, so the caller reports exactly what went away and nothing else.
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
    const paths = yield* PathsService;
    const relayRoots = { ...paths.roots, platform: paths.platform };
    const removeVolumes = input.options.volumes || input.options.purgeCaches;
    const volumeClasses = teardownVolumeClasses(input.options);
    const services: string[] = [];
    let volumesRemoved = false;
    for (const group of input.groups) {
      const plan = selectionPlan(group, input.root);
      const ref = { id: group.appId, root: input.root };
      yield* withAppMutationLock(
        appLockTarget(plan),
        Effect.gen(function* () {
          const provider = yield* registry.select(plan);
          for (const service of group.services) {
            const removal = yield* provider.removeObservedService(service);
            if (removal.kind === "removed") services.push(String(service.service));
          }
          if (!removeVolumes) return;
          for (const volume of group.volumes) {
            const generation = volume.identity?.generation;
            if (generation === undefined) continue;
            const volumeClass = volumeClassFromLabels(volume.labels);
            if (volumeClass === "data" && isGlobalScopedVolume(volume.labels)) continue;
            if (!volumeClasses.includes(volumeClass)) continue;
            yield* provider.removeVolume(volume.ref, generation);
            volumesRemoved = true;
          }
        }).pipe(
          Effect.ensuring(cleanupAgentRelayState(ref, relayRoots, "ssh")),
          Effect.ensuring(cleanupAgentRelayState(ref, relayRoots, "gpg")),
        ),
      );
    }
    return {
      app: String(input.groups[0]?.appId ?? ""),
      services,
      volumesRemoved,
    };
  });
