import type { ProviderUnavailableError } from "@lando/sdk/errors";
import { type AbsolutePath, type AppId, LANDO_DATA_ROOT_LABEL, planAppIdentity } from "@lando/sdk/schema";
import type { DestroyOptions } from "@lando/sdk/services";
import { Effect } from "effect";
import { inventoryDataRoot, matchesDataRoot } from "./data-root-labels.ts";
import type { makeResourceOwnershipStore } from "./resource-ownership.ts";
import {
  type SkippedVolume,
  type TeardownVolumeRuntime,
  type VolumeDeletionCandidate,
  matchesSharedCache,
  skippedVolume,
  snapshotVolumeDeletion,
} from "./teardown-volumes.ts";
import { STORAGE_SCOPE_LABEL, volumeClassFromLabels } from "./volume-classes.ts";
import { ownedVolumeLockTier, volumeOwnershipLabels } from "./volume-ownership.ts";

type Inventory = NonNullable<
  Effect.Success<ReturnType<ReturnType<typeof makeResourceOwnershipStore>["load"]>>
>;

/**
 * Choose the inventory volumes an ownership cleanup deletes. Each candidate is proven against
 * the daemon before it joins the set; a shared cache that cannot be proven is kept and reported,
 * while an unproven app volume fails the cleanup.
 */
export const planInventoryVolumeDeletions = Effect.fnUntraced(function* (input: {
  readonly root: AbsolutePath;
  readonly resources: Inventory["resources"];
  readonly options: DestroyOptions;
  readonly coverage: { readonly provider: string; readonly app: AppId } | undefined;
  readonly runtime: TeardownVolumeRuntime;
  readonly store: ReturnType<typeof makeResourceOwnershipStore>;
  readonly skipped: SkippedVolume[];
  readonly checkAppliedState?: (appId: AppId) => Effect.Effect<void, ProviderUnavailableError>;
  readonly userDataRoot?: string | undefined;
}) {
  const { root, resources, options, coverage, skipped } = input;
  const volumeRuntime = input.runtime;
  const candidates: VolumeDeletionCandidate[] = [];
  const volumeRecords = [];
  let unverifiedAppVolume = false;
  for (const resource of resources) {
    if (resource.kind !== "volume") continue;
    if (options.appIds !== undefined && !options.appIds.includes(resource.appId)) continue;
    const shared = resource.volumeScope === "global" && resource.volumeClass === "cache";
    if (coverage?.provider === resource.providerId && (shared || coverage.app === resource.appId)) continue;
    if (
      !(resource.volumeClass === "cache"
        ? options.purgeCaches
        : resource.volumeScope !== "global" && options.volumes)
    )
      continue;
    const store = { name: resource.nativeName, scope: resource.volumeScope, kind: resource.volumeClass };
    const expected = volumeOwnershipLabels(
      {
        id: resource.appId,
        provider: resource.providerId,
        root,
        identity: {
          ...planAppIdentity({ root }),
          ...(resource.dataRoot === undefined ? {} : { dataRoot: resource.dataRoot }),
        },
      },
      store,
    );
    const volume = {
      appId: resource.appId,
      name: resource.nativeName,
      volumeClass: resource.volumeClass,
      shared,
      tier: ownedVolumeLockTier(resource.appId, shared),
      matches: (labels: Readonly<Record<string, string>>) =>
        shared
          ? matchesSharedCache(resource.providerId, resource.nativeName, labels)
          : labels["dev.lando.app"] === resource.appId &&
            labels[STORAGE_SCOPE_LABEL] === resource.volumeScope &&
            volumeClassFromLabels(labels) === resource.volumeClass &&
            matchesDataRoot(
              labels[LANDO_DATA_ROOT_LABEL],
              inventoryDataRoot(labels[LANDO_DATA_ROOT_LABEL], resource.dataRoot, input.userDataRoot),
              true,
            ) &&
            Object.entries(expected).every(
              ([key, value]) => key === LANDO_DATA_ROOT_LABEL || labels[key] === value,
            ),
    };
    const readable = yield* (input.checkAppliedState?.(resource.appId) ?? Effect.void).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => shared || error.operation === "applied-state.read",
        (error) =>
          Effect.sync(() => {
            skipped.push(skippedVolume(volume, error.message));
            return false;
          }),
      ),
    );
    if (!readable) continue;
    const observed = yield* snapshotVolumeDeletion(volumeRuntime, volume).pipe(
      Effect.catchIf(
        () => shared,
        () => Effect.succeed({ kind: "unverified" } as const),
      ),
    );
    switch (observed.kind) {
      case "absent":
        if (shared) yield* input.store.retire(root, resource).pipe(Effect.catch(() => Effect.void));
        else yield* input.store.retire(root, resource);
        break;
      case "candidate":
        if (!candidates.some((candidate) => candidate.key === observed.candidate.key))
          candidates.push(observed.candidate);
        volumeRecords.push(resource);
        break;
      case "unverified":
        if (shared) skipped.push(skippedVolume(volume, "shared cache ownership could not be verified"));
        else unverifiedAppVolume = true;
        break;
    }
  }
  return { candidates, volumeRecords, unverifiedAppVolume };
});
