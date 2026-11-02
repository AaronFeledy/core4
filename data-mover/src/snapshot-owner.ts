import { SnapshotOwnershipError } from "@lando/sdk/errors";
import {
  type AppIdentity,
  type SnapshotInfo,
  type SnapshotMetadata,
  type VolumeInfo,
  type VolumeRef,
  planAppIdentity,
} from "@lando/sdk/schema";
import { Effect } from "effect";

export const physicalVolumeGeneration = (volume: VolumeInfo | undefined): string | undefined =>
  volume?.identity?.generation ?? (volume?.provenance === "known" ? volume.instanceId : undefined);

export const matchesSnapshotSource = (
  volume: VolumeInfo | undefined,
  metadata: SnapshotMetadata,
  owner: AppIdentity,
): boolean => {
  const identity = volume?.identity;
  return (
    physicalVolumeGeneration(volume) === metadata.volumeInstanceId &&
    identity !== undefined &&
    identity.ownerRoot === owner.appRoot &&
    identity.nativeName === volume?.ref.store
  );
};

export const snapshotSourceOwner = Effect.fn("DataMover.snapshotSourceOwner")(function* (
  volumes: ReadonlyArray<VolumeInfo>,
  store: VolumeRef,
  snapshotId: string,
) {
  const matches = volumes.filter(
    (volume) => volume.ref.app === store.app && volume.ref.store === store.store,
  );
  const source = matches[0];
  if (matches.length !== 1 || source?.identity?.nativeName !== store.store) {
    return yield* Effect.fail(
      new SnapshotOwnershipError({
        message: "Snapshot source must be exactly one volume with a verified owner identity.",
        snapshotId,
        sourceVolumeInstanceId: physicalVolumeGeneration(source) ?? "unknown",
        remediation:
          "Use database commands to adopt a legacy database volume; otherwise recreate the volume through Lando before taking a snapshot.",
      }),
    );
  }
  return { source, owner: planAppIdentity({ root: source.identity.ownerRoot }) };
});

export const requireSnapshotTargetOwner = (info: SnapshotInfo, target: VolumeInfo | undefined) =>
  target?.identity !== undefined && target.identity.ownerRoot !== info.owner.appRoot
    ? Effect.fail(
        new SnapshotOwnershipError({
          message: "Snapshot owner does not match the target volume owner.",
          snapshotId: info.id,
          sourceVolumeInstanceId: info.metadata?.volumeInstanceId ?? "unknown",
          targetVolumeInstanceId: target.identity.generation,
          remediation: "Move data between owners with db:export followed by db:import or db:seed <file>.",
        }),
      )
    : Effect.void;
