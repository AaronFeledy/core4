import { type StateStoreError, VolumeOperationError } from "@lando/sdk/errors";
import type { AppPlan, DataStorePlan, VolumeIdentity, VolumeLocator, VolumeRef } from "@lando/sdk/schema";
import { planDataId } from "@lando/sdk/schema";
import type { ProviderError, RuntimeProviderShape, StateStoreShape } from "@lando/sdk/services";
import {
  type VolumeLockMode,
  type VolumeLockRequest,
  heldVolumeLocks,
  holdsVolumeLock,
  withPhysicalVolumeLocks,
} from "@lando/state-store/volume-lock";
import { Context, Effect } from "effect";

import type { PreparedRuntimeProvider } from "../providers/prepared.ts";
import { shellArg } from "../services/shell-quote.ts";

type LocatedPlanVolume = {
  readonly ref: VolumeRef;
  readonly store: DataStorePlan;
  readonly locator: VolumeLocator;
};

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

const failure = (providerId: string, message: string) =>
  new VolumeOperationError({
    providerId,
    operation: "coordinateVolume",
    message,
    remediation: "Retry after the concurrent volume operation completes, then inspect volume ownership.",
  });

const sameIdentity = (left: VolumeIdentity | undefined, right: VolumeIdentity | undefined): boolean =>
  left === undefined
    ? right === undefined
    : right !== undefined &&
      left.coordinationKey === right.coordinationKey &&
      left.nativeName === right.nativeName &&
      left.generation === right.generation &&
      left.ownerRoot === right.ownerRoot &&
      left.origin === right.origin;

const uniqueByCoordinationKey = (
  volumes: ReadonlyArray<LocatedPlanVolume>,
): ReadonlyArray<LocatedPlanVolume> => {
  const unique = new Map<string, LocatedPlanVolume>();
  for (const volume of volumes) {
    if (!unique.has(volume.locator.coordinationKey)) unique.set(volume.locator.coordinationKey, volume);
  }
  return [...unique.values()].sort((left, right) =>
    left.locator.coordinationKey < right.locator.coordinationKey
      ? -1
      : left.locator.coordinationKey > right.locator.coordinationKey
        ? 1
        : 0,
  );
};

/** Proven present: explicit present, or identity with no absent proof. */
const locatorIsPresent = (locator: VolumeLocator): boolean =>
  locator.presence === "present" || (locator.presence !== "absent" && locator.identity !== undefined);

/**
 * Present global caches take shared so concurrent apps can start together.
 * An absent global cache (cold create) and every other store stay exclusive.
 * Callers that delete global caches force exclusive via `exclusive: true`
 * ({@link forceExclusiveForTeardown}); volumes-only teardown does not.
 */
export const volumeLockModeFor = (
  store: Pick<DataStorePlan, "scope" | "kind">,
  locator: VolumeLocator,
  exclusive: boolean,
): VolumeLockMode => {
  if (exclusive) return "exclusive";
  if (store.scope === "global" && store.kind === "cache" && locatorIsPresent(locator)) return "shared";
  return "exclusive";
};

/**
 * Destroy and superseded retirement force exclusive volume locks only when
 * purging caches. Volumes-only teardown leaves present global caches shared so
 * concurrent activations that hold those caches stay compatible; app data still
 * takes exclusive through {@link volumeLockModeFor}.
 */
export const forceExclusiveForTeardown = (options: { readonly purgeCaches?: boolean }): boolean =>
  options.purgeCaches === true;

const lockRequestsFor = (
  volumes: ReadonlyArray<LocatedPlanVolume>,
  exclusive: boolean,
): ReadonlyArray<VolumeLockRequest> =>
  volumes.map((volume) => ({
    key: volume.locator.coordinationKey,
    mode: volumeLockModeFor(volume.store, volume.locator, exclusive),
    resource: `volume ${volume.locator.nativeName}`,
  }));

const keySetOf = (volumes: ReadonlyArray<LocatedPlanVolume>): ReadonlyArray<string> =>
  [...new Set(volumes.map((volume) => volume.locator.coordinationKey))].sort();

const sameKeySet = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
};

const ownerRootMismatch = (
  plan: AppPlan,
  providerId: string,
  store: DataStorePlan,
  locator: VolumeLocator,
): VolumeOperationError | undefined => {
  if (
    locator.identity === undefined ||
    store.scope === "global" ||
    locator.identity.ownerRoot === (plan.identity?.appRoot ?? plan.root)
  ) {
    return undefined;
  }
  return new VolumeOperationError({
    providerId,
    operation: "coordinateVolume",
    store: store.name,
    message: `Volume ${locator.nativeName}${locator.nativeName === store.name ? "" : ` (store ${store.name})`} belongs to the app at ${locator.identity.ownerRoot}, not ${plan.identity?.appRoot ?? plan.root}.`,
    remediation: `If that folder still exists, give this app a different name: or this service a different explicit store:. An app keeps the data name it first started with after a rename, so renaming the other app does not free its volumes. If it is gone, run lando destroy --root ${shellArg(locator.identity.ownerRoot)} --volumes to delete its leftovers (this deletes that data), or move the app back there. lando doctor lists app folders that no longer exist.`,
  });
};

const locatePlanVolumes = (
  plan: AppPlan,
  provider: Pick<RuntimeProviderShape, "id" | "locateVolume">,
): Effect.Effect<ReadonlyArray<LocatedPlanVolume>, ProviderError> =>
  Effect.forEach(plan.stores, (store) => {
    const ref: VolumeRef = { app: planDataId(plan), store: store.name, scope: store.scope };
    return provider.locateVolume(ref).pipe(
      Effect.flatMap((locator) => {
        const mismatch = ownerRootMismatch(plan, provider.id, store, locator);
        if (mismatch !== undefined) return Effect.fail(mismatch);
        return Effect.succeed({ ref, store, locator });
      }),
    );
  });

/**
 * Locate every plan's volumes with that plan's own refs. Callers pass the desired plan plus the
 * applied plan a halt will also touch, so the two plans are never merged into a manufactured
 * AppPlan whose data identity could differ.
 */
const locateCoordinatedVolumes = (
  input: {
    readonly plan: AppPlan;
    readonly additionalPlans?: ReadonlyArray<AppPlan>;
  },
  provider: Pick<RuntimeProviderShape, "id" | "locateVolume">,
): Effect.Effect<ReadonlyArray<LocatedPlanVolume>, ProviderError> =>
  Effect.forEach([input.plan, ...(input.additionalPlans ?? [])], (plan) =>
    locatePlanVolumes(plan, provider),
  ).pipe(Effect.map((volumes) => volumes.flat()));

const verifyLocatedVolumes = (
  expected: ReadonlyArray<LocatedPlanVolume>,
  provider: Pick<RuntimeProviderShape, "id" | "locateVolume">,
): Effect.Effect<void, ProviderError> =>
  Effect.forEach(
    expected,
    (volume) =>
      provider
        .locateVolume(volume.ref)
        .pipe(
          Effect.flatMap((current) =>
            current.coordinationKey === volume.locator.coordinationKey &&
            current.nativeName === volume.locator.nativeName &&
            sameIdentity(current.identity, volume.locator.identity)
              ? Effect.void
              : Effect.fail(
                  failure(
                    provider.id,
                    `Volume ${volume.locator.nativeName} changed during lifecycle coordination.`,
                  ),
                ),
          ),
        ),
    { discard: true },
  );

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
  readonly provider: Pick<RuntimeProviderShape, "id" | "locateVolume">;
  readonly stateStore: StateStoreShape;
  /** Force exclusive holds (cache purge and SQL-style writers that remove shared volumes). */
  readonly exclusive?: boolean;
  readonly body: (coordination: VolumeCoordination) => Effect.Effect<A, E, R>;
}): Effect.fn.Return<A, E | ProviderError | StateStoreError, R> {
  const exclusive = input.exclusive === true;
  const runBody = (
    volumes: ReadonlyArray<LocatedPlanVolume>,
    body: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => body.pipe(Effect.provideService(ActiveLocatedVolumes, volumes));

  // Re-observe after acquire; if the locked key set changed, release and retry.
  for (;;) {
    const located = yield* locateCoordinatedVolumes(input, input.provider);
    const requests = lockRequestsFor(located, exclusive);
    const held = yield* heldVolumeLocks;
    const active = yield* ActiveLocatedVolumes;
    const coordination = (volumes: ReadonlyArray<LocatedPlanVolume>): VolumeCoordination => ({
      locators: volumes.map((volume) => volume.locator),
      verify: verifyLocatedVolumes(volumes, input.provider),
    });

    if (requests.every((request) => holdsVolumeLock(held, request))) {
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
          !lockRequestsFor(fresh, exclusive).every((request) => holdsVolumeLock(currentHolds, request))
        ) {
          return { _tag: "retry" as const };
        }
        const bound = uniqueByCoordinationKey([...active, ...fresh]);
        const result = yield* runBody(bound, input.body(coordination(uniqueByCoordinationKey(fresh))));
        return { _tag: "done" as const, result };
      }),
    );

    if (outcome._tag === "done") return outcome.result;
  }
});

/** Launch work must prepare the runtime before volume discovery acquires its locks. */
export const withLaunchVolumeCoordination = <A, E, R>(input: {
  readonly plan: AppPlan;
  readonly additionalPlans?: ReadonlyArray<AppPlan>;
  readonly provider: PreparedRuntimeProvider;
  readonly stateStore: StateStoreShape;
  readonly exclusive?: boolean;
  readonly body: (coordination: VolumeCoordination) => Effect.Effect<A, E, R>;
}) => withPlanVolumeCoordination(input);
