import {
  type AdoptionReceipt,
  adoptionReceiptsFromSummary,
  dataRootRefusal,
  decideDataRootOwnership,
} from "@lando/container-runtime/native-ownership";
import { ownedVolumeLockTier } from "@lando/container-runtime/volume-ownership";
import { mapFailures } from "@lando/sdk/command-result";
import { VolumeOperationError } from "@lando/sdk/errors";
import type { AppPlan, DataStorePlan, VolumeIdentity, VolumeLocator, VolumeRef } from "@lando/sdk/schema";
import { LANDO_DATA_ROOT_LABEL, type PhysicalVolumeLockTier, planDataId } from "@lando/sdk/schema";
import { type ProviderError, RuntimeProviderRegistry, type RuntimeProviderShape } from "@lando/sdk/services";
import { Effect, Option } from "effect";

import { shellArg } from "../services/shell-quote.ts";

// Locating a plan's volumes and proving they did not change while their locks were held.

export type LocatedPlanVolume = {
  readonly ref: VolumeRef;
  readonly store: DataStorePlan;
  readonly locator: VolumeLocator;
  readonly tier?: PhysicalVolumeLockTier;
};

export const isGlobalCache = (store: Pick<DataStorePlan, "scope" | "kind">): boolean =>
  store.scope === "global" && store.kind === "cache";

/**
 * The global app's stores rank above every user app's volumes. Plugins can name them explicitly,
 * so their owner, not their name, decides the tier. A user start
 * already holds its own keys when it starts global services, and nothing takes a global-app key
 * and then a user key, so this order cannot invert.
 */
export const volumeLockTierFor = (
  plan: Pick<AppPlan, "id">,
  store: Pick<DataStorePlan, "scope" | "kind">,
): PhysicalVolumeLockTier | undefined => ownedVolumeLockTier(plan.id, isGlobalCache(store));

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
  evidence: { readonly locator: VolumeLocator; readonly receipts: readonly AdoptionReceipt[] },
): VolumeOperationError | undefined => {
  const { locator, receipts } = evidence;
  const expected = plan.identity?.dataRoot;
  const labels = locator.presence === "absent" ? undefined : locator.labels;
  const resource = {
    kind: "volume",
    nativeName: locator.nativeName,
    labels,
    volumeInstance: labels?.["dev.lando.volume-instance"],
  } as const;
  if (
    !isGlobalCache(store) &&
    locator.presence === "present" &&
    (expected === undefined
      ? locator.labels?.[LANDO_DATA_ROOT_LABEL] !== undefined
      : decideDataRootOwnership(resource, { dataRoot: expected, receipts }) !== "owned")
  ) {
    return new VolumeOperationError({
      providerId,
      operation: "coordinateVolume",
      store: store.name,
      ...dataRootRefusal(resource),
    });
  }
  if (
    locator.identity === undefined ||
    isGlobalCache(store) ||
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
        Effect.flatMap(
          Effect.fnUntraced(function* (locator) {
            let receipts: readonly AdoptionReceipt[] = [];
            if (
              locator.presence === "present" &&
              locator.labels?.[LANDO_DATA_ROOT_LABEL] === undefined &&
              plan.identity?.dataRoot !== undefined &&
              !isGlobalCache(store)
            ) {
              const registry = yield* Effect.serviceOption(RuntimeProviderRegistry);
              if (Option.isSome(registry) && registry.value.resourceOwnership !== undefined) {
                const ownership = yield* registry.value
                  .resourceOwnership(plan.provider, plan.root)
                  .pipe(mapFailures((cause) => coordinationFailure(provider.id, cause.message)));
                receipts = adoptionReceiptsFromSummary(ownership);
              }
            }
            const mismatch = ownerRootMismatch(plan, provider.id, store, { locator, receipts });
            if (mismatch !== undefined) return yield* mismatch;
            const tier = volumeLockTierFor(plan, store);
            return { ref, store, locator, ...(tier === undefined ? {} : { tier }) };
          }),
        ),
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
