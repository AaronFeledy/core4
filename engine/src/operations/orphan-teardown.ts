import {
  isGlobalScopedVolume,
  teardownVolumeClasses,
  volumeClassFromLabels,
} from "@lando/container-runtime/volume-classes";
import { orDieWithRole } from "@lando/sdk/command-result";
import {
  type AppLockTimeoutError,
  type AppResolveError,
  type AppliedStateVersionError,
  ProviderUnavailableError,
  type StateStoreError,
} from "@lando/sdk/errors";
import type {
  AbsolutePath,
  AppPlan,
  OwnedResourcesCleanupResult,
  ServiceShutdownObservation,
  VolumeRemovalCounts,
} from "@lando/sdk/schema";
import { addVolumeRemovalCounts, noVolumesRemoved } from "@lando/sdk/schema";
import {
  type AppliedOrphanGroup,
  EventService,
  type PathsService,
  type ProviderError,
  type ProviderSelectionError,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { withPhysicalVolumeLocks } from "@lando/state-store/volume-lock";
import { DateTime, Effect, Option } from "effect";

import { appLockTarget, withAppMutationLock } from "./app-mutation-lock.ts";
import { cleanupAppWorkers } from "./destroy-provider.ts";
import { ownedCleanupChanged, prepareOwnedResourceCleanup } from "./owned-resource-teardown.ts";
import { withShutdownObservations } from "./shutdown-observations.ts";

/** A damaged or newer-format applied record protects its app's resources from the sweep. */
const isProtectedAppliedState = <E extends { readonly _tag: string }>(
  error: E,
): error is Extract<E, ProviderUnavailableError | AppliedStateVersionError> =>
  error._tag === "AppliedStateVersionError" ||
  (error instanceof ProviderUnavailableError && error.operation === "applied-state.read");

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
  readonly volumesRemoved: VolumeRemovalCounts;
  readonly ownedChanged: boolean;
  /** Provider-contributed shutdown facts; omitted when no removal supplied observations. */
  readonly shutdownObservations?: readonly ServiceShutdownObservation[];
}

export type OrphanTeardownError =
  | AppResolveError
  | ProviderError
  | ProviderSelectionError
  | AppLockTimeoutError
  | StateStoreError;

const now = () => DateTime.nowUnsafe();

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
export const tearDownOrphans = Effect.fnUntraced(function* (input: {
  readonly root: AbsolutePath;
  readonly groups: ReadonlyArray<AppliedOrphanGroup>;
  readonly options: OrphanTeardownOptions;
  readonly ownedCleanup?: Effect.Effect<OwnedResourcesCleanupResult, ProviderError>;
}): Effect.fn.Return<
  OrphanTeardownResult,
  OrphanTeardownError,
  RuntimeProviderRegistry | PathsService | PrivateFileAccessService
> {
  return yield* withAppMutationLock(
    { id: input.groups[0]?.appId ?? input.root, root: input.root },
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      const cleanup = input.ownedCleanup ?? (yield* prepareOwnedResourceCleanup(input.root, input.options));
      const removeVolumes = input.options.volumes || input.options.purgeCaches;
      const volumeClasses = teardownVolumeClasses(input.options);
      const services: string[] = [];
      const observationSources: Array<readonly ServiceShutdownObservation[] | undefined> = [];
      const volumesRemoved: { data: number; cache: number } = { ...noVolumesRemoved };
      for (const group of input.groups) {
        const plan = selectionPlan(group, input.root);
        const ref = { id: group.appId, root: input.root };
        let protectedState = false;
        yield* withAppMutationLock(
          appLockTarget(plan),
          Effect.gen(function* () {
            const provider = yield* registry.select(plan);
            for (const service of group.services) {
              const removal = yield* provider.bringDownObserved(service, "remove");
              observationSources.push(removal.shutdownObservations);
              if (removal.action === "removed") services.push(String(service.service));
            }
            if (!removeVolumes) return;
            const candidates = group.volumes.flatMap((volume) => {
              if (volume.identity === undefined) return [];
              const volumeClass = volumeClassFromLabels(volume.labels);
              if (volumeClass === "data" && isGlobalScopedVolume(volume.labels)) return [];
              return volumeClasses.includes(volumeClass)
                ? [{ ref: volume.ref, identity: volume.identity, volumeClass }]
                : [];
            });
            if (candidates.length === 0) return;
            const state = yield* Effect.serviceOption(StateStore);
            if (Option.isNone(state))
              return yield* new ProviderUnavailableError({
                providerId: provider.id,
                operation: "destroy",
                message: "Orphan volume removal requires the physical volume lock service.",
                remediation: "Retry with the normal Lando runtime bootstrap.",
              });
            yield* withPhysicalVolumeLocks(
              state.value,
              candidates.map(({ identity }) => ({
                key: identity.coordinationKey,
                name: identity.nativeName,
                resource: `volume ${identity.nativeName}`,
              })),
              Effect.forEach(
                candidates,
                ({ ref, identity, volumeClass }) =>
                  provider.removeVolume(ref, identity.generation).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        volumesRemoved[volumeClass] += 1;
                      }),
                    ),
                  ),
                { discard: true },
              ),
            );
          }).pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                protectedState = isProtectedAppliedState(error);
              }),
            ),
            Effect.ensuring(Effect.suspend(() => (protectedState ? Effect.void : cleanupAppWorkers(ref)))),
          ),
        ).pipe(
          Effect.catchIf(isProtectedAppliedState, (error) =>
            Effect.gen(function* () {
              const events = yield* Effect.serviceOption(EventService);
              if (Option.isSome(events))
                yield* events.value
                  .publish({
                    _tag: "message.warn",
                    body: `Skipped resources for app ${group.appId}: ${error.message} ${error.remediation}`,
                    timestamp: now(),
                  })
                  .pipe(orDieWithRole("cleanup"));
            }),
          ),
        );
      }
      const owned = yield* cleanup;
      return withShutdownObservations(
        {
          app: String(input.groups[0]?.appId ?? ""),
          services: [...new Set([...services, ...owned.servicesRemoved])],
          volumesRemoved: addVolumeRemovalCounts(volumesRemoved, owned.volumesRemoved),
          ownedChanged: ownedCleanupChanged(owned),
        },
        ...observationSources,
      );
    }),
  );
});
