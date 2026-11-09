import { isGlobalScopedVolume, volumeClassFromLabels } from "@lando/container-runtime/volume-classes";
import type { AbsolutePath, OwnedResourcesCleanupResult, ProviderId, VolumeInfo } from "@lando/sdk/schema";
import { planAppIdentity } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import { clearAppDataIdentity } from "../planner/data-identity.ts";
import { TeardownProvider } from "../providers/app-placement.ts";
import { runtimeOnline } from "../providers/runtime-observation.ts";

export type DataIdentityClearEvidence = {
  readonly root: AbsolutePath;
  /** Destroy asked to remove data volumes (`--volumes`). Cache-only and plain destroy keep the record. */
  readonly volumesRequested: boolean;
  /** Cleanup skipped any protected resource — incomplete, keep the record. */
  readonly skipped?: OwnedResourcesCleanupResult["skipped"];
};

const unobservedProviderMayHoldData = Effect.fnUntraced(function* (
  providerId: ProviderId,
  root: AbsolutePath,
) {
  const registry = yield* RuntimeProviderRegistry;
  if (registry.resourceOwnership === undefined) return true;
  return yield* registry.resourceOwnership(providerId, root).pipe(
    Effect.map((ownership) => ownership !== undefined),
    // An unreadable inventory is unknown evidence, so the record stays.
    Effect.catch(() => Effect.succeed(true)),
  );
});

/** The native name of a user data volume this root owns, else undefined. */
const ownedDataVolumeName = (volume: VolumeInfo, root: AbsolutePath): string | undefined =>
  (volume.identity?.ownerRoot ?? volume.labels?.["dev.lando.volume-owner"]) !== root ||
  volume.ref.app === "global" ||
  isGlobalScopedVolume(volume.labels) ||
  volume.labels?.["dev.lando.scratch"] === "TRUE" ||
  volumeClassFromLabels(volume.labels) !== "data"
    ? undefined
    : (volume.identity?.nativeName ?? volume.ref.store);

const remainingDataVolumesForRoot = Effect.fnUntraced(function* (root: AbsolutePath) {
  const registry = yield* RuntimeProviderRegistry;
  const names = new Set<string>();

  // Live observation across providers is preferred when the registry exposes it.
  if (registry.observeRuntime !== undefined) {
    const snapshots = yield* registry.observeRuntime;
    if (snapshots.length === 0) names.add("unobserved:providers");
    for (const snapshot of snapshots) {
      // Lando inventories every volume before creating it, so a provider whose runtime cannot be
      // observed holds this folder's data only if its ownership inventory still lists the folder.
      if (!snapshot.runtimeObserved && (yield* unobservedProviderMayHoldData(snapshot.providerId, root)))
        names.add(`unobserved:${snapshot.providerId}`);
      for (const volume of snapshot.volumes) {
        const name = ownedDataVolumeName(volume, root);
        if (name !== undefined) names.add(name);
      }
    }
    return names;
  }

  // Fallback: list volumes on each installed provider. Never treat a list failure as absence.
  const providerIds = yield* registry.list;
  if (providerIds.length === 0) names.add("unobserved:providers");
  for (const providerId of providerIds) {
    const provider = yield* registry.select(providerId);
    if (!(yield* runtimeOnline(provider))) {
      names.add(`unobserved:${providerId}`);
      continue;
    }
    const volumes = yield* provider.listVolumes({});
    for (const volume of volumes) {
      const name = ownedDataVolumeName(volume, root);
      if (name !== undefined) names.add(name);
    }
  }
  return names;
});

/**
 * Clear the folder's data-identity record only with complete evidence that root data volumes are
 * removed or already absent: `--volumes` requested, no skipped cleanup resources, and no provider
 * still holding data for the root. Never trusts `volumesRemoved` booleans. Plain/cache-only destroy
 * and incomplete observation keep the record. Scratch/global never write.
 */
export const clearAppDataIdentityWhenComplete = Effect.fn("AppDataIdentity.clearWhenComplete")(function* (
  evidence: DataIdentityClearEvidence,
) {
  if (!evidence.volumesRequested || (evidence.skipped?.length ?? 0) > 0) return;
  if ((yield* TeardownProvider) !== undefined) return;

  const remaining = yield* remainingDataVolumesForRoot(evidence.root).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (remaining === undefined || remaining.size > 0) return;

  yield* clearAppDataIdentity(planAppIdentity({ root: evidence.root }));
});
