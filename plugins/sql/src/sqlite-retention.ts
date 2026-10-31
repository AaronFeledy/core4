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
