import { SnapshotId, type SnapshotInfo } from "@lando/sdk/schema";
import { DateTime } from "effect";

/** DataMover counts retained IDs within keepLatest, so reserve a slot for every protected snapshot. */
export const sqliteRetentionSelection = (
  snapshots: ReadonlyArray<SnapshotInfo>,
  targetIdentity: string,
  keepLatest: number,
  recovery: boolean,
  retainIds: ReadonlyArray<string> = [],
) => {
  const eligible = snapshots.filter((snapshot) => {
    const manual =
      snapshot.metadata?.recoveryReason === undefined || snapshot.metadata.recoveryReason === "manual";
    return recovery ? !manual : manual;
  });
  const matching = eligible
    .filter((snapshot) => snapshot.metadata?.volumeInstanceId === targetIdentity)
    .sort((left, right) => DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt));
  const eligibleIds = new Set(eligible.map((snapshot) => snapshot.id));
  const retain = new Set([
    ...retainIds.filter((id) => eligibleIds.has(id)),
    ...eligible
      .filter((snapshot) => snapshot.metadata?.volumeInstanceId !== targetIdentity)
      .map((snapshot) => snapshot.id),
    ...matching.slice(0, keepLatest).map((snapshot) => snapshot.id),
  ]);
  return {
    keepLatest: retain.size,
    retainSnapshotIds: [...retain].map((id) => SnapshotId.make(id)),
    candidates: matching.filter((snapshot) => !retain.has(snapshot.id)),
  };
};

/** Manual cleanup follows the selected catalog scope without opening its database. */
export const sqliteSnapshotCatalogKey = (snapshot: SnapshotInfo): string =>
  JSON.stringify([
    snapshot.owner.appRoot,
    snapshot.owner.ownerKey,
    snapshot.store.app,
    snapshot.store.store,
    snapshot.id,
  ]);

export const sqliteManualPruneSelection = (snapshots: ReadonlyArray<SnapshotInfo>, keepLatest: number) => {
  const groups = new Map<string, SnapshotInfo[]>();
  for (const snapshot of snapshots) {
    if (snapshot.metadata?.family !== "sqlite" || snapshot.metadata.recoveryReason !== "manual") continue;
    const key = JSON.stringify([
      snapshot.owner.appRoot,
      snapshot.owner.ownerKey,
      snapshot.store.app,
      snapshot.store.store,
      snapshot.metadata.service,
      snapshot.metadata.volumeInstanceId,
    ]);
    const group = groups.get(key) ?? [];
    group.push(snapshot);
    groups.set(key, group);
  }
  return {
    candidates: [...groups.values()].flatMap((group) =>
      group
        .sort(
          (left, right) =>
            DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt) ||
            left.id.localeCompare(right.id),
        )
        .slice(keepLatest),
    ),
  };
};
