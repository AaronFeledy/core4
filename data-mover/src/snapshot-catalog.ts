import { readdir, rmdir, unlink } from "node:fs/promises";
import type { LandoPaths } from "@lando/paths";
import { SnapshotAmbiguousError, SnapshotNotFoundError, StateStoreError, errnoCode } from "@lando/sdk/errors";
import {
  AbsolutePath,
  type SnapshotFilter,
  type SnapshotHandle,
  SnapshotInfo,
  appIdentityKey,
  snapshotHandle,
} from "@lando/sdk/schema";
import type { RuntimeProviderRegistry, StateStoreShape } from "@lando/sdk/services";
import { type Context, DateTime, Effect } from "effect";
import {
  type SnapshotAddress,
  containedSnapshotPath,
  ownerDirectoryPattern,
  requireOwnerKey,
  snapshotPaths,
  stateFailure,
} from "./snapshot-paths.ts";

export interface SnapshotPersistence {
  readonly paths: LandoPaths;
  readonly stateStore: StateStoreShape;
  readonly providerRegistry?: Context.Service.Shape<typeof RuntimeProviderRegistry>;
}

export const openSnapshot = Effect.fn("DataMover.openSnapshot")(function* (
  persistence: SnapshotPersistence,
  handle: SnapshotAddress,
) {
  const paths = yield* snapshotPaths(persistence.paths, handle);
  return yield* persistence.stateStore
    .open({
      root: { path: AbsolutePath.make(paths.store) },
      key: `${handle.id}.json`,
      schema: SnapshotInfo,
      version: 1,
      codec: "json",
      onCorrupt: "fail",
      onVersionMismatch: (_raw, version) => {
        throw new StateStoreError({
          reason: "version",
          operation: "read-snapshot",
          remediation: `Unsupported snapshot sidecar version ${version}; use a compatible Lando build.`,
        });
      },
    })
    .pipe(Effect.mapError((cause) => stateFailure("open", cause)));
});

export const readSnapshot = Effect.fn("DataMover.readSnapshot")(function* (
  persistence: SnapshotPersistence,
  handle: SnapshotHandle,
) {
  const bucket = yield* openSnapshot(persistence, handle);
  const info = yield* bucket.get.pipe(Effect.mapError((cause) => stateFailure("read-sidecar", cause)));
  if (info === null) return undefined;
  if (
    info.owner.ownerKey !== handle.ownerKey ||
    info.owner.ownerKey !== appIdentityKey("owner", info.owner.appRoot) ||
    info.id !== handle.id ||
    info.store.store !== handle.store.store ||
    info.store.app !== handle.store.app ||
    info.store.scope !== handle.store.scope
  )
    return yield* Effect.fail(stateFailure("read-sidecar", "Snapshot content disagrees with its address."));
  return info;
});

export const findSnapshotInfo = Effect.fn("DataMover.findSnapshotInfo")(function* (
  persistence: SnapshotPersistence,
  handle: SnapshotHandle,
) {
  const info = yield* readSnapshot(persistence, handle);
  if (info === undefined)
    return yield* Effect.fail(
      new SnapshotNotFoundError({
        message: `Snapshot ${handle.id} was not found.`,
        snapshotId: handle.id,
        store: handle.store.store,
        remediation: "List snapshots and retry with an existing owner-bound handle.",
      }),
    );
  return info;
});

export const readSnapshotDirectory = (path: string) =>
  Effect.tryPromise({
    try: () => readdir(path, { withFileTypes: true }),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      errnoCode(cause) === "ENOENT" ? Effect.succeed([]) : Effect.fail(stateFailure("list", cause)),
    ),
  );

const snapshotMatches = (info: SnapshotInfo, filter: SnapshotFilter): boolean =>
  (filter.id === undefined || info.id === filter.id) &&
  (filter.app === undefined || info.store.app === filter.app) &&
  (filter.store === undefined || info.store.store === filter.store) &&
  (filter.ownerKey === undefined || info.owner.ownerKey === filter.ownerKey) &&
  (filter.repoGroupKey === undefined || info.owner.repoGroupKey === filter.repoGroupKey) &&
  (filter.service === undefined || info.metadata?.service === filter.service) &&
  (filter.scope === undefined || info.store.scope === filter.scope) &&
  (filter.label === undefined || info.label === filter.label) &&
  Object.entries(filter.labels ?? {}).every(([key, value]) => info.labels?.[key] === value) &&
  (filter.createdAfter === undefined ||
    DateTime.toEpochMillis(info.createdAt) > DateTime.toEpochMillis(filter.createdAfter)) &&
  (filter.createdBefore === undefined ||
    DateTime.toEpochMillis(info.createdAt) < DateTime.toEpochMillis(filter.createdBefore));

export const listSnapshotInfos = Effect.fn("DataMover.listSnapshotInfos")(function* (
  persistence: SnapshotPersistence,
  filter: SnapshotFilter,
) {
  if (filter.ownerKey !== undefined) yield* requireOwnerKey(filter.ownerKey);
  const root = yield* containedSnapshotPath(persistence.paths, []);
  const owners =
    filter.ownerKey === undefined
      ? (yield* readSnapshotDirectory(root))
          .filter(
            (entry) =>
              ownerDirectoryPattern.test(entry.name) && (entry.isDirectory() || entry.isSymbolicLink()),
          )
          .map((entry) => entry.name)
      : [filter.ownerKey];
  const infos: SnapshotInfo[] = [];
  for (const ownerKey of owners) {
    const ownerDir = yield* containedSnapshotPath(persistence.paths, [ownerKey]);
    for (const store of yield* readSnapshotDirectory(ownerDir)) {
      if (!store.isDirectory() && !store.isSymbolicLink()) continue;
      const storeDir = yield* containedSnapshotPath(persistence.paths, [ownerKey, store.name]);
      for (const entry of yield* readSnapshotDirectory(storeDir)) {
        if (!entry.name.endsWith(".json")) continue;
        const id = entry.name.slice(0, -5);
        // app/scope are content, not directory components. Validate the path before opening the bucket.
        const address = { ownerKey, id, store: { store: store.name } };
        const bucket = yield* openSnapshot(persistence, address);
        const info = yield* bucket.get.pipe(Effect.mapError((cause) => stateFailure("read-sidecar", cause)));
        if (info === null) continue;
        if (
          info.owner.ownerKey !== ownerKey ||
          info.id !== id ||
          info.store.store !== store.name ||
          info.owner.ownerKey !== appIdentityKey("owner", info.owner.appRoot)
        ) {
          return yield* Effect.fail(stateFailure("read-sidecar", bucket.path));
        }
        if (snapshotMatches(info, filter)) infos.push(info);
      }
    }
  }
  // Directory order varies by filesystem; listings are oldest first, then by id.
  return infos.toSorted(
    (left, right) =>
      DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
});

export const resolveSnapshotInfo = Effect.fn("DataMover.resolveSnapshotInfo")(function* (
  persistence: SnapshotPersistence,
  reference: string,
  scope: SnapshotFilter,
) {
  const infos = yield* listSnapshotInfos(persistence, scope);
  const ids = infos.filter((info) => info.id === reference);
  const matches = (ids.length > 0 ? ids : infos.filter((info) => info.label === reference)).toSorted(
    (left, right) => DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt),
  );
  if (matches.length > 1)
    return yield* Effect.fail(
      new SnapshotAmbiguousError({
        message: `Snapshot ${reference} matches ${matches.length} snapshots in the selected scope.`,
        snapshotId: reference,
        matchCount: matches.length,
        candidateIds: matches.map((info) => info.id),
        remediation: "List snapshots in this scope and retry with an unambiguous id.",
      }),
    );
  const info = matches[0];
  if (info !== undefined) return info;
  return yield* Effect.fail(
    new SnapshotNotFoundError({
      message: `Snapshot ${reference} was not found.`,
      snapshotId: reference,
      remediation: "Run `lando db:snapshots` in this scope and retry with an existing id or label.",
    }),
  );
});

export const removeSnapshotArchive = (path: string) =>
  Effect.tryPromise({
    try: () => unlink(path),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      errnoCode(cause) === "ENOENT" ? Effect.void : Effect.fail(stateFailure("remove-archive", cause)),
    ),
  );

export const removeEmptySnapshotDirectories = Effect.fn("DataMover.removeEmptySnapshotDirectories")(
  function* (persistence: SnapshotPersistence, info: SnapshotInfo) {
    const paths = yield* snapshotPaths(persistence.paths, snapshotHandle(info));
    for (const path of [paths.store, paths.owner])
      yield* Effect.tryPromise({
        try: () => rmdir(path),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          errnoCode(cause) === "ENOENT" || errnoCode(cause) === "ENOTEMPTY"
            ? Effect.void
            : Effect.fail(stateFailure("remove-directory", cause)),
        ),
      );
  },
);
