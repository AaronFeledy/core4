import { type StateStoreError, VolumeOperationError } from "@lando/sdk/errors";
import type { AppPlan, VolumeIdentity, VolumeLocator, VolumeRef } from "@lando/sdk/schema";
import { planDataId } from "@lando/sdk/schema";
import {
  type ProviderError,
  type RuntimeProviderShape,
  type StateStoreShape,
  physicalVolumeLockKey,
} from "@lando/sdk/services";
import { Context, Effect } from "effect";

import type { PreparedRuntimeProvider } from "../providers/prepared.ts";
import { shellArg } from "../services/shell-quote.ts";

type LocatedPlanVolume = {
  readonly ref: VolumeRef;
  readonly locator: VolumeLocator;
};

export interface VolumeCoordination {
  readonly locators: ReadonlyArray<VolumeLocator>;
  readonly verify: Effect.Effect<void, ProviderError>;
}

const HeldCoordinationKeys = Context.Reference<ReadonlySet<string>>("@lando/engine/HeldCoordinationKeys", {
  defaultValue: (): ReadonlySet<string> => new Set(),
});
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

const locatePlanVolumes = (
  plan: AppPlan,
  provider: Pick<RuntimeProviderShape, "id" | "locateVolume">,
): Effect.Effect<ReadonlyArray<LocatedPlanVolume>, ProviderError> =>
  Effect.forEach(plan.stores, (store) => {
    const ref: VolumeRef = { app: planDataId(plan), store: store.name, scope: store.scope };
    return provider.locateVolume(ref).pipe(
      Effect.flatMap((locator) => {
        if (
          locator.identity !== undefined &&
          store.scope !== "global" &&
          locator.identity.ownerRoot !== (plan.identity?.appRoot ?? plan.root)
        ) {
          return Effect.fail(
            new VolumeOperationError({
              providerId: provider.id,
              operation: "coordinateVolume",
              store: store.name,
              message: `Volume ${locator.nativeName}${locator.nativeName === store.name ? "" : ` (store ${store.name})`} belongs to the app at ${locator.identity.ownerRoot}, not ${plan.identity?.appRoot ?? plan.root}.`,
              remediation: `If that folder still exists, give this app a different name: or this service a different explicit store:. An app keeps the data name it first started with after a rename, so renaming the other app does not free its volumes. If it is gone, run lando destroy --root ${shellArg(locator.identity.ownerRoot)} --volumes to delete its leftovers (this deletes that data), or move the app back there. lando doctor lists app folders that no longer exist.`,
            }),
          );
        }
        return Effect.succeed({ ref, locator });
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
  ).pipe(Effect.map((volumes) => uniqueByCoordinationKey(volumes.flat())));

/**
 * A nested plan expansion may only add keys above every key this fiber already holds. Every
 * multi-plan phase acquires its complete union up front, so a lower key proves a new nesting site
 * would invert the global lock order and eventually deadlock instead of failing where it started.
 */
const assertNestedLockOrder = (
  missing: ReadonlyArray<LocatedPlanVolume>,
  held: ReadonlySet<string>,
): Effect.Effect<void> => {
  const firstMissing = missing[0]?.locator.coordinationKey;
  if (firstMissing === undefined || held.size === 0) return Effect.void;
  let highestHeld = "";
  for (const key of held) if (key > highestHeld) highestHeld = key;
  if (firstMissing > highestHeld) return Effect.void;
  return Effect.die(
    new Error(
      `Volume lock ordering violated: ${firstMissing} is not held and sorts below already-held ${highestHeld}. A lifecycle phase must acquire every volume key it will need in sorted order before it starts; this is a Lando bug.`,
    ),
  );
};

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

export const withVolumeCoordinationLock = <A, E>(
  stateStore: StateStoreShape,
  coordinationKey: string,
  body: Effect.Effect<A, E>,
): Effect.Effect<A, E | StateStoreError> =>
  HeldCoordinationKeys.pipe(
    Effect.flatMap((held) =>
      held.has(coordinationKey) ? body : stateStore.withLock(physicalVolumeLockKey(coordinationKey), body),
    ),
  );

export const withPlanVolumeCoordination = Effect.fn("Lifecycle.withPlanVolumeCoordination")(function* <
  A,
  E,
  R,
>(input: {
  readonly plan: AppPlan;
  readonly additionalPlans?: ReadonlyArray<AppPlan>;
  readonly provider: Pick<RuntimeProviderShape, "id" | "locateVolume">;
  readonly stateStore: StateStoreShape;
  readonly body: (coordination: VolumeCoordination) => Effect.Effect<A, E, R>;
}): Effect.fn.Return<A, E | ProviderError | StateStoreError, R> {
  const located = yield* locateCoordinatedVolumes(input, input.provider);
  const keys = located.map((volume) => volume.locator.coordinationKey);
  const held = yield* HeldCoordinationKeys;
  const active = yield* ActiveLocatedVolumes;
  const coordination: VolumeCoordination = {
    locators: located.map((volume) => volume.locator),
    verify: verifyLocatedVolumes(located, input.provider),
  };
  const runBody = (
    binding: { readonly held: ReadonlySet<string>; readonly active: ReadonlyArray<LocatedPlanVolume> },
    body: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    body.pipe(
      Effect.provideService(HeldCoordinationKeys, binding.held),
      Effect.provideService(ActiveLocatedVolumes, binding.active),
    );
  if (keys.every((key) => held.has(key))) return yield* runBody({ held, active }, input.body(coordination));

  // Advisory locks are not reentrant: a nested phase whose plan adds volumes (a halt that tears
  // down the applied plan inside a launch holding the desired plan's keys) takes only the new keys.
  const missing = located.filter((volume) => !held.has(volume.locator.coordinationKey));
  yield* assertNestedLockOrder(missing, held);
  const union = {
    held: new Set([...held, ...keys]),
    active: uniqueByCoordinationKey([...active, ...located]),
  };
  const lockAll = (index: number): Effect.Effect<A, E | ProviderError | StateStoreError, R> => {
    const volume = missing[index];
    if (volume === undefined) {
      return verifyLocatedVolumes(located, input.provider).pipe(
        Effect.andThen(runBody(union, input.body(coordination))),
      );
    }
    return input.stateStore.withLock(
      physicalVolumeLockKey(volume.locator.coordinationKey),
      lockAll(index + 1),
    );
  };

  return yield* lockAll(0);
});

/** Launch work must prepare the runtime before volume discovery acquires its locks. */
export const withLaunchVolumeCoordination = <A, E, R>(input: {
  readonly plan: AppPlan;
  readonly additionalPlans?: ReadonlyArray<AppPlan>;
  readonly provider: PreparedRuntimeProvider;
  readonly stateStore: StateStoreShape;
  readonly body: (coordination: VolumeCoordination) => Effect.Effect<A, E, R>;
}) => withPlanVolumeCoordination(input);
