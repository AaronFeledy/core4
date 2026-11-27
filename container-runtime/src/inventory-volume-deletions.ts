import { type AppliedStateVersionError, ProviderUnavailableError } from "@lando/sdk/errors";
import { type AbsolutePath, type AppId, LANDO_DATA_ROOT_LABEL, planAppIdentity } from "@lando/sdk/schema";
import type { OwnedResourcesCleanupOptions } from "@lando/sdk/services";
import { Effect } from "effect";
import { type AdoptionReceipt, dataRootRefusal, decideDataRootOwnership } from "./data-root-ownership.ts";
import { VOLUME_INSTANCE_LABEL } from "./labels.ts";
import type { makeResourceOwnershipStore } from "./resource-ownership.ts";
import { ownershipFailure } from "./resource-ownership-inventory.ts";
import { retireAbsentVolumeReceipt } from "./teardown-volume-receipts.ts";
import {
  type SkippedVolume,
  type TeardownVolumeRuntime,
  type VolumeDeletionCandidate,
  matchesSharedCache,
  protectedSkip,
  skippedVolume,
  snapshotVolumeDeletion,
} from "./teardown-volumes.ts";
import { STORAGE_SCOPE_LABEL, volumeClassFromLabels } from "./volume-classes.ts";
import { GLOBAL_CACHE_OWNER, ownedVolumeLockTier, volumeOwnershipLabels } from "./volume-ownership.ts";

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
  readonly options: OwnedResourcesCleanupOptions;
  readonly coverage: { readonly provider: string; readonly app: AppId } | undefined;
  readonly runtime: TeardownVolumeRuntime;
  readonly store: ReturnType<typeof makeResourceOwnershipStore>;
  readonly skipped: SkippedVolume[];
  readonly userDataRoot?: string | undefined;
  readonly receipts: readonly AdoptionReceipt[];
  readonly checkAppliedState?: (
    appId: AppId,
  ) => Effect.Effect<void, ProviderUnavailableError | AppliedStateVersionError>;
}) {
  const { root, resources, options, coverage, skipped } = input;
  const volumeRuntime = input.runtime;
  const candidates: VolumeDeletionCandidate[] = [];
  const volumeRecords = [];
  let refusal: ProviderUnavailableError | undefined;
  for (const resource of resources) {
    if (resource.kind !== "volume") continue;
    const dataRoot = input.userDataRoot ?? resource.dataRoot;
    if (options.appIds !== undefined && !options.appIds.includes(resource.appId)) continue;
    const shared = resource.volumeScope === "global" && resource.volumeClass === "cache";
    if (shared && options.releaseCaches === true && options.purgeCaches !== true) {
      yield* input.store.retire(root, resource);
      continue;
    }
    const retainedGlobal =
      resource.volumeScope === "global" &&
      resource.volumeClass === "data" &&
      input.receipts.some(
        (receipt) =>
          receipt.kind === "volume" &&
          receipt.nativeName === resource.nativeName &&
          receipt.appId === resource.appId &&
          receipt.dataRoot === dataRoot,
      );
    const covered =
      !retainedGlobal &&
      coverage?.provider === resource.providerId &&
      (shared || coverage.app === resource.appId);
    if (
      !(resource.volumeClass === "cache"
        ? options.purgeCaches
        : (resource.volumeScope !== "global" || retainedGlobal) && options.volumes)
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
      ownerRoot: shared ? GLOBAL_CACHE_OWNER : root,
      tier: ownedVolumeLockTier(resource.appId, shared),
      matches: (labels: Readonly<Record<string, string>>) =>
        shared
          ? matchesSharedCache(resource.providerId, resource.nativeName, labels)
          : labels["dev.lando.app"] === resource.appId &&
            labels[STORAGE_SCOPE_LABEL] === resource.volumeScope &&
            volumeClassFromLabels(labels) === resource.volumeClass &&
            (dataRoot === undefined
              ? labels[LANDO_DATA_ROOT_LABEL] === undefined
              : decideDataRootOwnership(
                  {
                    kind: "volume",
                    nativeName: resource.nativeName,
                    labels,
                    volumeInstance: labels[VOLUME_INSTANCE_LABEL],
                  },
                  { dataRoot, receipts: input.receipts },
                ) === "owned") &&
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
            skipped.push({ ...skippedVolume(volume, error.message), ...protectedSkip(error) });
            return false;
          }),
      ),
    );
    if (!readable) continue;
    const observed = yield* snapshotVolumeDeletion(volumeRuntime, volume).pipe(
      Effect.catchIf(
        () => shared,
        () =>
          Effect.succeed({
            kind: "unverified",
            labels: {} satisfies Readonly<Record<string, string>>,
          } as const),
      ),
    );
    switch (observed.kind) {
      case "absent":
        // A shared cache's receipt belongs to its class owner, and another app may recreate the
        // volume outside this app's lock, so only an app volume's leftover receipt is retired.
        if (shared) yield* input.store.retire(root, resource).pipe(Effect.catch(() => Effect.void));
        else {
          yield* retireAbsentVolumeReceipt(volumeRuntime, root, resource.nativeName);
          yield* input.store.retire(root, resource);
        }
        break;
      case "candidate":
        if (covered) break;
        if (!candidates.some((candidate) => candidate.key === observed.candidate.key))
          candidates.push(observed.candidate);
        volumeRecords.push(resource);
        break;
      case "unverified":
        if (covered) break;
        if (shared) skipped.push(skippedVolume(volume, "shared cache ownership could not be verified"));
        else {
          const labels: Readonly<Record<string, string>> = observed.labels;
          if (labels[LANDO_DATA_ROOT_LABEL] !== undefined && labels[LANDO_DATA_ROOT_LABEL] !== dataRoot)
            refusal = new ProviderUnavailableError({
              providerId: resource.providerId,
              operation: "resource-ownership",
              ...dataRootRefusal({ kind: "volume", nativeName: resource.nativeName, labels }),
            });
          else refusal ??= ownershipFailure(resource.providerId);
        }
        break;
    }
  }
  return { candidates, volumeRecords, refusal };
});
