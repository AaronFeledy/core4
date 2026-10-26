import { lstat, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { type LandoPaths, isPathWithin } from "@lando/paths";
import { DataTransferError, errnoCode } from "@lando/sdk/errors";
import type { SnapshotHandle, SnapshotInfo } from "@lando/sdk/schema";
import { Effect } from "effect";

export const ownerDirectoryPattern = /^[0-9a-f]{64}$/u;
const segmentPattern = /^[^/\\\0:]+$/u;

export type SnapshotAddress = Pick<SnapshotHandle, "ownerKey" | "id"> & {
  readonly store: Pick<SnapshotHandle["store"], "store">;
};

export const stateFailure = (operation: string, cause: unknown): DataTransferError =>
  new DataTransferError({
    message: `Snapshot store ${operation} failed.`,
    operation,
    cause,
    remediation: "Inspect the Lando snapshot store under the configured userDataRoot.",
  });

export const requireSafeSegment = (segment: string) =>
  segment !== "." && segment !== ".." && segmentPattern.test(segment)
    ? Effect.void
    : Effect.fail(stateFailure("validate-path", `Unsafe snapshot path segment: ${JSON.stringify(segment)}`));

export const requireOwnerKey = (key: string) =>
  ownerDirectoryPattern.test(key)
    ? Effect.void
    : Effect.fail(stateFailure("validate-path", "Snapshot owner key must be 64 lowercase hex characters."));

// Only absence permits walking up: permissions and dangling/looping symlinks must not bypass containment.
const canonicalPath = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch (cause) {
    if (errnoCode(cause) !== "ENOENT" || dirname(path) === path) throw cause;
    const entry = await lstat(path).catch((error: unknown) => {
      if (errnoCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (entry?.isSymbolicLink()) throw stateFailure("validate-path", "Dangling snapshot symlink.");
    const parent = dirname(path);
    return join(await canonicalPath(parent), relative(parent, path));
  }
};

export const containedSnapshotPath = Effect.fnUntraced(function* (
  paths: LandoPaths,
  segments: ReadonlyArray<string>,
) {
  yield* Effect.forEach(segments, requireSafeSegment);
  return yield* Effect.tryPromise({
    try: async () => {
      const root = await canonicalPath(resolve(paths.snapshotsDir));
      const path = join(root, ...segments);
      const canonical = await canonicalPath(path);
      if (!isPathWithin(root, canonical)) throw stateFailure("validate-path", path);
      return path;
    },
    catch: (cause) => stateFailure("validate-path", cause),
  });
});

export const snapshotPaths = Effect.fn("DataMover.snapshotPaths")(function* (
  paths: LandoPaths,
  handle: SnapshotAddress,
) {
  yield* requireOwnerKey(handle.ownerKey);
  yield* requireSafeSegment(handle.id);
  yield* requireSafeSegment(handle.store.store);
  const owner = yield* containedSnapshotPath(paths, [handle.ownerKey]);
  const store = yield* containedSnapshotPath(paths, [handle.ownerKey, handle.store.store]);
  const sidecar = yield* containedSnapshotPath(paths, [
    handle.ownerKey,
    handle.store.store,
    `${handle.id}.json`,
  ]);
  return { owner, store, sidecar };
});

export const snapshotArchivePath = Effect.fn("DataMover.snapshotArchivePath")(function* (
  paths: LandoPaths,
  info: Pick<SnapshotInfo, "owner" | "store" | "id" | "format">,
) {
  yield* snapshotPaths(paths, { ownerKey: info.owner.ownerKey, store: info.store, id: info.id });
  return yield* containedSnapshotPath(paths, [
    info.owner.ownerKey,
    info.store.store,
    `${info.id}.${info.format ?? "tar"}`,
  ]);
});
