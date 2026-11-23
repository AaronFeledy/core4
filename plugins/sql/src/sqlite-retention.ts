import { SnapshotId, type SnapshotInfo, snapshotInPruneBucket } from "@lando/sdk/schema";
import { DateTime } from "effect";

/** DataMover counts retained IDs within keepLatest, so reserve a slot for every protected snapshot. */
export const sqliteRetentionSelection = (
  snapshots: ReadonlyArray<SnapshotInfo>,
  path: string,
  keepLatest: number,
  recovery: boolean,
  retainIds: ReadonlyArray<string> = [],
) => {
  const eligible = snapshots.filter((snapshot) => snapshotInPruneBucket(snapshot, recovery));
  const matching = eligible
    .filter((snapshot) => snapshot.metadata?.path === path)
    .sort(
      (left, right) =>
        DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt) ||
        left.id.localeCompare(right.id),
    );
  const eligibleIds = new Set(eligible.map((snapshot) => snapshot.id));
  const protectedIds = new Set(retainIds.filter((id) => eligibleIds.has(id)));
  const protectedMatching = matching.filter((snapshot) => protectedIds.has(snapshot.id));
  const retain = new Set([
    ...protectedIds,
    ...eligible.filter((snapshot) => snapshot.metadata?.path !== path).map((snapshot) => snapshot.id),
    ...matching
      .filter((snapshot) => !protectedIds.has(snapshot.id))
      .slice(0, Math.max(0, keepLatest - protectedMatching.length))
      .map((snapshot) => snapshot.id),
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

/** `db:snapshots:prune` keeps the newest snapshots of the selected bucket per service and path. */
export const sqlitePruneSelection = (
  snapshots: ReadonlyArray<SnapshotInfo>,
  keepLatest: number,
  recovery: boolean,
) => {
  const groups = new Map<string, { readonly path: string; readonly snapshots: SnapshotInfo[] }>();
  for (const snapshot of snapshots) {
    const metadata = snapshot.metadata;
    // Server metadata's family is an open string, so `path` is what narrows to the SQLite shape.
    if (metadata?.family !== "sqlite" || metadata.path === undefined) continue;
    const key = JSON.stringify([metadata.service, metadata.path]);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { path: metadata.path, snapshots: [snapshot] });
    else group.snapshots.push(snapshot);
  }
  return {
    candidates: [...groups.values()].flatMap(
      (group) => sqliteRetentionSelection(group.snapshots, group.path, keepLatest, recovery).candidates,
    ),
  };
};
