import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SNAPSHOT_STORE_LABEL, VOLUME_SNAPSHOT_LABEL } from "@lando/container-runtime/labels";
import type { LandoPaths } from "@lando/paths";
import { DataTransferError, errnoCode } from "@lando/sdk/errors";
import type { SnapshotInfo, VolumeSnapshotArtifact } from "@lando/sdk/schema";
import type { DataMoverError, RuntimeProviderShape } from "@lando/sdk/services";
import { Clock, DateTime, Effect, Schema } from "effect";
import { readSnapshotDirectory } from "./snapshot-catalog.ts";
import { ownerDirectoryPattern } from "./snapshot-paths.ts";

export const SNAPSHOT_ORPHAN_GRACE_MS = 60 * 60 * 1000;

const legacyCatalog = Schema.Struct({
  version: Schema.Literal(1),
  data: Schema.Array(
    Schema.Struct({
      native: Schema.optionalKey(Schema.Struct({ provider: Schema.String, id: Schema.String })),
    }),
  ),
});

const legacyCatalogFailure = (file: string, cause: unknown) =>
  new DataTransferError({
    operation: "legacy-snapshot-catalog",
    message: `Cannot read legacy snapshot catalog ${file}.`,
    cause,
    remediation: `Recover ${file} before retrying GC. Deleting it releases protection of its native images.`,
  });

export const findLegacySnapshotCatalogs = Effect.fn("DataMover.findLegacySnapshotCatalogs")(function* (
  paths: LandoPaths,
) {
  const catalogs: string[] = [];
  for (const entry of yield* readSnapshotDirectory(paths.snapshotsDir)) {
    if (ownerDirectoryPattern.test(entry.name) || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    const file = join(paths.snapshotsDir, entry.name, "index.bin");
    const exists = yield* Effect.tryPromise({
      try: () => lstat(file),
      catch: (cause) => cause,
    }).pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        errnoCode(cause) === "ENOENT"
          ? Effect.succeed(false)
          : Effect.fail(legacyCatalogFailure(file, cause)),
      ),
    );
    if (exists) catalogs.push(file);
  }
  return catalogs.sort();
});

// Never quarantine legacy ownership evidence: unreadable catalogs must block GC, not release images.
export const legacySnapshotReferences = Effect.fn("DataMover.legacySnapshotReferences")(function* (
  paths: LandoPaths,
) {
  const refs: Array<{ readonly provider: string; readonly id: string }> = [];
  for (const file of yield* findLegacySnapshotCatalogs(paths)) {
    const failure = (cause: unknown) => legacyCatalogFailure(file, cause);
    const text = yield* Effect.tryPromise({ try: () => readFile(file, "utf8"), catch: failure });
    const raw = yield* Effect.try({ try: (): unknown => JSON.parse(text), catch: failure });
    const catalog = yield* Schema.decodeUnknownEffect(legacyCatalog)(raw).pipe(Effect.mapError(failure));
    for (const info of catalog.data) if (info.native !== undefined) refs.push(info.native);
  }
  return refs;
});

export const orphanedSnapshotMethods = (options: {
  readonly provider: RuntimeProviderShape;
  readonly storeIdentity: Effect.Effect<string, DataMoverError>;
  readonly index: Effect.Effect<ReadonlyArray<SnapshotInfo>, DataMoverError>;
  readonly legacyReferences?: Effect.Effect<
    ReadonlyArray<{ readonly provider: string; readonly id: string }>,
    DataMoverError
  >;
}) => {
  const failure = (cause: unknown) =>
    new DataTransferError({
      operation: "orphanedSnapshots",
      message: "Provider snapshot reconciliation failed.",
      remediation: "Check provider health with lando doctor and retry.",
      cause,
    });
  const eligible = Effect.fn("DataMover.orphanedSnapshotEligible")(function* (
    artifact: VolumeSnapshotArtifact,
    refs: ReadonlyArray<{ readonly provider: string; readonly id: string }>,
  ) {
    if (artifact.ref.provider !== options.provider.id) return false;
    const identity = yield* options.storeIdentity;
    if (
      artifact.labels[SNAPSHOT_STORE_LABEL] !== identity &&
      artifact.labels[VOLUME_SNAPSHOT_LABEL] !== undefined
    )
      return false;
    if (
      DateTime.toEpochMillis(artifact.createdAt) >
      (yield* Clock.currentTimeMillis) - SNAPSHOT_ORPHAN_GRACE_MS
    )
      return false;
    return !refs.some((ref) => ref.provider === artifact.ref.provider && ref.id === artifact.ref.id);
  });
  const listArtifacts = (options.provider.listVolumeSnapshots?.() ?? Effect.succeed([])).pipe(
    Effect.mapError(failure),
  );
  const references = Effect.gen(function* () {
    const infos = yield* options.index;
    const legacy = yield* options.legacyReferences ?? Effect.succeed([]);
    return [...infos.flatMap((info) => (info.native === undefined ? [] : [info.native])), ...legacy];
  });
  return {
    findOrphanedSnapshots: Effect.gen(function* () {
      const artifacts = yield* listArtifacts;
      const index = yield* references;
      return yield* Effect.filter(artifacts, (artifact) => eligible(artifact, index));
    }),
    removeOrphanedSnapshot: Effect.fn("DataMover.removeOrphanedSnapshot")(function* (
      artifact: VolumeSnapshotArtifact,
    ) {
      // Re-observe instead of trusting the report: removal deletes by tag, so the image must still be
      // the one reported, and listing fails rather than starting a runtime that stopped meanwhile.
      const current = (yield* listArtifacts).find(
        (observed) => observed.ref.id === artifact.ref.id && observed.ref.digest === artifact.ref.digest,
      );
      const refs = yield* references;
      if (current === undefined || !(yield* eligible(current, refs))) {
        return yield* Effect.fail(
          new DataTransferError({
            operation: "removeOrphanedSnapshot",
            message: `Snapshot ${artifact.ref.id} is no longer eligible for orphan removal.`,
            remediation:
              "Run lando snapshots:gc again to review the current orphan report before retrying cleanup.",
          }),
        );
      }
      yield* Effect.scoped(options.provider.removeVolumeSnapshot(artifact.ref, { startRuntime: false })).pipe(
        Effect.mapError(failure),
      );
    }),
  };
};
