import { Effect, FiberRef } from "effect";

import { type StateStoreError, VolumeOperationError } from "@lando/sdk/errors";
import type { AppPlan, VolumeIdentity, VolumeLocator, VolumeRef } from "@lando/sdk/schema";
import { type RuntimeProviderShape, type StateStoreShape, physicalVolumeLockKey } from "@lando/sdk/services";

type LocatedPlanVolume = {
  readonly ref: VolumeRef;
  readonly locator: VolumeLocator;
};

export interface VolumeCoordination {
  readonly locators: ReadonlyArray<VolumeLocator>;
  readonly verify: Effect.Effect<void, VolumeOperationError>;
}

const heldCoordinationKeys = FiberRef.unsafeMake<ReadonlySet<string>>(new Set());
const activeLocatedVolumes = FiberRef.unsafeMake<ReadonlyArray<LocatedPlanVolume>>([]);

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

const locatePlanVolumes = (
  plan: AppPlan,
  provider: Pick<RuntimeProviderShape, "id" | "locateVolume">,
): Effect.Effect<ReadonlyArray<LocatedPlanVolume>, VolumeOperationError> =>
  Effect.forEach(plan.stores, (store) => {
    const ref: VolumeRef = { app: plan.id, store: store.name, scope: store.scope };
    return provider.locateVolume(ref).pipe(
      Effect.flatMap((locator) => {
        if (
          locator.identity !== undefined &&
          store.scope !== "global" &&
          locator.identity.ownerRoot !== (plan.identity?.appRoot ?? plan.root)
        ) {
          return Effect.fail(
            failure(provider.id, `Volume ${locator.nativeName} is owned by another app root.`),
          );
        }
        return Effect.succeed({ ref, locator });
      }),
      Effect.mapError((cause) =>
        cause instanceof VolumeOperationError
          ? cause
          : failure(
              provider.id,
              `Could not locate provider volume ${store.name} for lifecycle coordination.`,
            ),
      ),
    );
  });

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

const verifyLocatedVolumes = (
  expected: ReadonlyArray<LocatedPlanVolume>,
  provider: Pick<RuntimeProviderShape, "id" | "locateVolume">,
): Effect.Effect<void, VolumeOperationError> =>
  Effect.forEach(
    expected,
    (volume) =>
      provider.locateVolume(volume.ref).pipe(
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
        Effect.mapError((cause) =>
          cause instanceof VolumeOperationError
            ? cause
            : failure(provider.id, `Could not reobserve provider volume ${volume.locator.nativeName}.`),
        ),
      ),
    { discard: true },
  );

export const verifyActiveVolumeCoordination = (
  provider: Pick<RuntimeProviderShape, "id" | "locateVolume">,
): Effect.Effect<void, VolumeOperationError> =>
  FiberRef.get(activeLocatedVolumes).pipe(
    Effect.flatMap((volumes) => verifyLocatedVolumes(volumes, provider)),
  );

export const withVolumeCoordinationLock = <A, E>(
  stateStore: StateStoreShape,
  coordinationKey: string,
  body: Effect.Effect<A, E>,
): Effect.Effect<A, E | StateStoreError> =>
  FiberRef.get(heldCoordinationKeys).pipe(
    Effect.flatMap((held) =>
      held.has(coordinationKey) ? body : stateStore.withLock(physicalVolumeLockKey(coordinationKey), body),
    ),
  );

export const withPlanVolumeCoordination = <A, E>(input: {
  readonly plan: AppPlan;
  readonly provider: Pick<RuntimeProviderShape, "id" | "locateVolume">;
  readonly stateStore: StateStoreShape;
  readonly body: (coordination: VolumeCoordination) => Effect.Effect<A, E>;
}): Effect.Effect<A, E | VolumeOperationError | StateStoreError> =>
  Effect.gen(function* () {
    const planVolumes = yield* locatePlanVolumes(input.plan, input.provider);
    const located = uniqueByCoordinationKey(planVolumes);
    const keys = located.map((volume) => volume.locator.coordinationKey);
    const held = yield* FiberRef.get(heldCoordinationKeys);
    const coordination: VolumeCoordination = {
      locators: located.map((volume) => volume.locator),
      verify: verifyLocatedVolumes(located, input.provider),
    };
    if (keys.every((key) => held.has(key))) return yield* input.body(coordination);

    const lockAll = (index: number): Effect.Effect<A, E | VolumeOperationError | StateStoreError> => {
      const volume = located[index];
      if (volume === undefined) {
        return verifyLocatedVolumes(located, input.provider).pipe(Effect.zipRight(input.body(coordination)));
      }
      return input.stateStore.withLock(
        physicalVolumeLockKey(volume.locator.coordinationKey),
        lockAll(index + 1),
      );
    };

    return yield* lockAll(0).pipe(
      Effect.locally(activeLocatedVolumes, located),
      Effect.locally(heldCoordinationKeys, new Set([...held, ...keys])),
    );
  });
