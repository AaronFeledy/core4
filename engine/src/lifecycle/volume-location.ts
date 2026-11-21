import { VolumeOperationError } from "@lando/sdk/errors";
import type { AppPlan, DataStorePlan, VolumeIdentity, VolumeLocator, VolumeRef } from "@lando/sdk/schema";
import { planDataId } from "@lando/sdk/schema";
import type { ProviderError, RuntimeProviderShape } from "@lando/sdk/services";
import { Effect } from "effect";

import { shellArg } from "../services/shell-quote.ts";

// Locating a plan's volumes and proving they did not change while their locks were held.

export type LocatedPlanVolume = {
  readonly ref: VolumeRef;
  readonly store: DataStorePlan;
  readonly locator: VolumeLocator;
};

export const isGlobalCache = (store: Pick<DataStorePlan, "scope" | "kind">): boolean =>
  store.scope === "global" && store.kind === "cache";

export const coordinationFailure = (providerId: string, message: string) =>
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

export const uniqueByCoordinationKey = (
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

export const keySetOf = (volumes: ReadonlyArray<LocatedPlanVolume>): ReadonlyArray<string> =>
  [...new Set(volumes.map((volume) => volume.locator.coordinationKey))].sort();

export const sameKeySet = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean => {
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
export const locateCoordinatedVolumes = (
  input: {
    readonly plan: AppPlan;
    readonly additionalPlans?: ReadonlyArray<AppPlan>;
    readonly cachePolicy?: "apply" | "purge" | undefined;
  },
  provider: Pick<RuntimeProviderShape, "id" | "locateVolume">,
): Effect.Effect<ReadonlyArray<LocatedPlanVolume>, ProviderError> =>
  Effect.forEach([input.plan, ...(input.additionalPlans ?? [])], (plan) =>
    locatePlanVolumes(plan, provider, input.cachePolicy !== undefined),
  ).pipe(Effect.map((volumes) => volumes.flat()));

export const verifyLocatedVolumes = (
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
                  coordinationFailure(
                    provider.id,
                    `Volume ${volume.locator.nativeName} changed during lifecycle coordination.`,
                  ),
                ),
          ),
        ),
    { discard: true },
  );
