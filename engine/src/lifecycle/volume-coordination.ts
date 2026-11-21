import { StateStoreError, VolumeOperationError } from "@lando/sdk/errors";
import type { AppPlan, DataStorePlan, VolumeIdentity, VolumeLocator, VolumeRef } from "@lando/sdk/schema";
import { planDataId } from "@lando/sdk/schema";
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

const isGlobalCache = (store: Pick<DataStorePlan, "scope" | "kind">): boolean =>
  store.scope === "global" && store.kind === "cache";

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
  includeCaches: boolean,
): Effect.Effect<ReadonlyArray<LocatedPlanVolume>, ProviderError> =>
  Effect.forEach(
    plan.stores.filter((store) => includeCaches || !isGlobalCache(store)),
    (store) => {
      const ref: VolumeRef = { app: planDataId(plan), store: store.name, scope: store.scope };
      return provider.locateVolume(ref).pipe(
        Effect.flatMap((locator) => {
          const mismatch = ownerRootMismatch(plan, provider.id, store, locator);
          if (mismatch !== undefined) return Effect.fail(mismatch);
          return Effect.succeed({ ref, store, locator });
        }),
      );
    },
  );

/**
 * Locate every plan's volumes with that plan's own refs. Callers pass the desired plan plus the
 * applied plan a halt will also touch, so the two plans are never merged into a manufactured
 * AppPlan whose data identity could differ.
 */
const locateCoordinatedVolumes = (
  input: {
    readonly plan: AppPlan;
    readonly additionalPlans?: ReadonlyArray<AppPlan>;
    readonly cachePolicy?: CachePolicy | undefined;
  },
  provider: Pick<RuntimeProviderShape, "id" | "locateVolume">,
): Effect.Effect<ReadonlyArray<LocatedPlanVolume>, ProviderError> =>
  Effect.forEach([input.plan, ...(input.additionalPlans ?? [])], (plan) =>
    locatePlanVolumes(plan, provider, input.cachePolicy !== undefined),
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
          return yield* failure(
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
