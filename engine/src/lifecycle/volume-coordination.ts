import { StateStoreError } from "@lando/sdk/errors";
import type { AppPlan, DataStorePlan, VolumeLocator } from "@lando/sdk/schema";
import {
  type ProviderError,
  type RuntimeProviderShape,
  type StateStoreShape,
  physicalVolumeLockKey,
} from "@lando/sdk/services";
import {
  type VolumeLockMode,
  type VolumeLockRequest,
  heldVolumeLocks,
  holdsVolumeLock,
  physicalVolumeLockDeadline,
  withPhysicalVolumeLocks,
} from "@lando/state-store/volume-lock";
import { Clock, Context, Effect } from "effect";

import type { PreparedRuntimeProvider } from "../providers/prepared.ts";
import {
  type LocatedPlanVolume,
  coordinationFailure,
  isGlobalCache,
  keySetOf,
  locateCoordinatedVolumes,
  sameKeySet,
  uniqueByCoordinationKey,
  verifyLocatedVolumes,
} from "./volume-location.ts";

export interface VolumeCoordination {
  readonly locators: ReadonlyArray<VolumeLocator>;
  readonly verify: Effect.Effect<void, ProviderError>;
}

const ActiveLocatedVolumes = Context.Reference<ReadonlyArray<LocatedPlanVolume>>(
  "@lando/engine/ActiveLocatedVolumes",
  {
    defaultValue: (): ReadonlyArray<LocatedPlanVolume> => [],
  },
);

/** Proven present: explicit present, or identity with no absent proof. */
const locatorIsPresent = (locator: VolumeLocator): boolean =>
  locator.presence === "present" || (locator.presence !== "absent" && locator.identity !== undefined);

type CachePolicy = "apply" | "purge";
type VolumeProvider = Pick<RuntimeProviderShape, "id" | "locateVolume"> & {
  readonly capabilities?: Pick<RuntimeProviderShape["capabilities"], "serializesVolumeCopyUp">;
};

const volumeLockModeFor = (
  store: Pick<DataStorePlan, "scope" | "kind">,
  locator: VolumeLocator,
  sharedCaches: boolean,
): VolumeLockMode => {
  if (sharedCaches && isGlobalCache(store) && locatorIsPresent(locator)) return "shared";
  return "exclusive";
};

/**
 * Destroy and superseded retirement only coordinate global caches when deleting them.
 */
export const cachePolicyForTeardown = (options: { readonly purgeCaches?: boolean }): "purge" | undefined =>
  options.purgeCaches === true ? "purge" : undefined;

const lockRequestsFor = (
  volumes: ReadonlyArray<LocatedPlanVolume>,
  sharedCaches: boolean,
): ReadonlyArray<VolumeLockRequest> =>
  volumes.map((volume) => ({
    key: volume.locator.coordinationKey,
    name: volume.locator.nativeName,
    mode: volumeLockModeFor(volume.store, volume.locator, sharedCaches),
    resource: `volume ${volume.locator.nativeName}`,
  }));

export const verifyActiveVolumeCoordination = (
  provider: Pick<RuntimeProviderShape, "id" | "locateVolume">,
): Effect.Effect<void, ProviderError> =>
  ActiveLocatedVolumes.pipe(Effect.flatMap((volumes) => verifyLocatedVolumes(volumes, provider)));

export const withPlanVolumeCoordination = Effect.fn("Lifecycle.withPlanVolumeCoordination")(function* <
  A,
  E,
  R,
>(input: {
  readonly plan: AppPlan;
  readonly additionalPlans?: ReadonlyArray<AppPlan>;
  readonly provider: VolumeProvider;
  readonly stateStore: StateStoreShape;
  readonly cachePolicy?: CachePolicy | undefined;
  readonly body: (coordination: VolumeCoordination) => Effect.Effect<A, E, R>;
}): Effect.fn.Return<A, E | ProviderError | StateStoreError, R> {
  const sharedCaches =
    input.cachePolicy === "apply" && input.provider.capabilities?.serializesVolumeCopyUp === true;
  const deadline = yield* physicalVolumeLockDeadline;
  const held = yield* heldVolumeLocks;
  const active = yield* ActiveLocatedVolumes;
  const boundAtAdmission = (volume: LocatedPlanVolume) =>
    active.find(
      ({ ref }) =>
        ref.app === volume.ref.app && ref.store === volume.ref.store && ref.scope === volume.ref.scope,
    );
  const runBody = (
    volumes: ReadonlyArray<LocatedPlanVolume>,
    body: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => body.pipe(Effect.provideService(ActiveLocatedVolumes, volumes));

  // Re-observe after acquire; if the locked key set changed, release and retry.
  for (;;) {
    const located = yield* locateCoordinatedVolumes(input, input.provider);
    if (input.cachePolicy === "apply") {
      for (const volume of located) {
        const expected = boundAtAdmission(volume);
        if (expected !== undefined && expected.locator.coordinationKey !== volume.locator.coordinationKey) {
          return yield* coordinationFailure(
            input.provider.id,
            `Volume ${expected.locator.nativeName} changed during lifecycle coordination.`,
          );
        }
      }
    }
    const requests = lockRequestsFor(located, sharedCaches);
    const coordination = (volumes: ReadonlyArray<LocatedPlanVolume>): VolumeCoordination => ({
      locators: volumes.map((volume) => volume.locator),
      verify: verifyLocatedVolumes(
        input.cachePolicy === "apply" ? volumes.map((volume) => boundAtAdmission(volume) ?? volume) : volumes,
        input.provider,
      ),
    });

    if (input.cachePolicy !== "apply" && requests.every((request) => holdsVolumeLock(held, request))) {
      const bound = uniqueByCoordinationKey([...active, ...located]);
      return yield* runBody(
        bound,
        input.body(
          coordination(
            bound.filter((volume) =>
              requests.some((request) => request.key === volume.locator.coordinationKey),
            ),
          ),
        ),
      );
    }

    // A nested phase whose plan adds volumes takes only the new keys (volume-lock
    // enforces order and mode upgrades). Post-lock bindings merge already-active volumes.
    const outcome = yield* withPhysicalVolumeLocks(
      input.stateStore,
      requests,
      Effect.gen(function* () {
        const fresh = yield* locateCoordinatedVolumes(input, input.provider);
        const currentHolds = yield* heldVolumeLocks;
        if (
          !sameKeySet(keySetOf(located), keySetOf(fresh)) ||
          !lockRequestsFor(fresh, sharedCaches).every(
            (request) =>
              holdsVolumeLock(currentHolds, request) &&
              (held.has(request.key) ||
                request.mode === "exclusive" ||
                currentHolds.get(request.key)?.mode === "shared"),
          )
        ) {
          return { _tag: "retry" as const };
        }
        const bound = uniqueByCoordinationKey([...active, ...fresh]);
        const result = yield* runBody(bound, input.body(coordination(uniqueByCoordinationKey(fresh))));
        return { _tag: "done" as const, result };
      }),
      deadline,
    );

    if (outcome._tag === "done") return outcome.result;
    if ((yield* Clock.monotonicTimeNanos) >= deadline.expiresAt) {
      const resource = `volumes for ${input.plan.id}`;
      return yield* new StateStoreError({
        reason: "lock",
        lockFailure: "timeout",
        operation: "coordinateVolume",
        path: physicalVolumeLockKey(requests[0]?.key ?? input.plan.id),
        resource,
        timeoutMs: deadline.timeoutMs,
        message: `Timed out coordinating ${resource} after ${deadline.timeoutMs} ms.`,
        remediation: "Wait for the concurrent volume operation to finish, then retry.",
      });
    }
  }
});

/** Launch work must prepare the runtime before volume discovery acquires its locks. */
export const withLaunchVolumeCoordination = <A, E, R>(input: {
  readonly plan: AppPlan;
  readonly additionalPlans?: ReadonlyArray<AppPlan>;
  readonly provider: PreparedRuntimeProvider;
  readonly stateStore: StateStoreShape;
  readonly body: (coordination: VolumeCoordination) => Effect.Effect<A, E, R>;
}) => withPlanVolumeCoordination(input);
