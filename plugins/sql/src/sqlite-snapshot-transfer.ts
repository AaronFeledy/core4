import { snapshotArchivePath } from "@lando/data-mover/snapshot-paths";
import { mapFailures } from "@lando/sdk/command-result";
import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import type { SnapshotInfo } from "@lando/sdk/schema";
import { persistVerifiedStream } from "@lando/sdk/verified-stream";
import { Effect, Stream } from "effect";

import { unpackSqliteTarFile } from "./sqlite-archive.ts";
import { type SqliteSnapshotDeps, sqliteSnapshotCatalogFailure } from "./sqlite-snapshot.ts";

export const stageVerifiedSqliteImport = (
  sourcePath: string,
  destinationPath: string,
  expectedDigest: string,
  service: string,
): Effect.Effect<void, SqlRecoveryUnavailableError> =>
  Effect.scoped(
    persistVerifiedStream({
      body: Stream.fromReadableStream({
        evaluate: () => Bun.file(sourcePath).stream(),
        onError: (cause) => cause,
      }),
      destinationPath,
      expectedSha256: expectedDigest,
      // The host stages bytes for the verified database uid in its isolated helper scratch mount.
      // A host-owned 0600 file would be unreadable when that uid differs from the Lando process.
      mode: 0o644,
    }).pipe(
      Effect.asVoid,
      mapFailures((cause) =>
        sqliteSnapshotCatalogFailure(service, "Cannot stage a verified SQLite import payload.", cause),
      ),
    ),
  );

export const extractSqliteSnapshotArchiveToFile = (
  archivePath: string,
  destPath: string,
  service: string,
): Effect.Effect<void, SqlRecoveryUnavailableError> =>
  Effect.tryPromise({
    try: async () => {
      const ok = await unpackSqliteTarFile(archivePath, destPath);
      if (!ok) throw new Error("The archive is missing a SQLite payload.");
    },
    catch: (cause) =>
      new SqlRecoveryUnavailableError({
        message: `Snapshot archive for ${service} is not a SQLite database tar.`,
        service,
        reason: String(cause),
        remediation: "Use a matching SQLite snapshot created by lando db:snapshot.",
      }),
  });

export const copySqliteSnapshotArchive = (
  deps: Pick<SqliteSnapshotDeps, "paths">,
  info: SnapshotInfo,
  destPath: string,
  service: string,
): Effect.Effect<void, SqlRecoveryUnavailableError> => {
  if (info.format !== "tar" || !/^[a-zA-Z0-9_-]+$/u.test(info.id)) {
    return Effect.fail(
      sqliteSnapshotCatalogFailure(
        service,
        "Cannot read the SQLite snapshot archive.",
        "Expected tar format and a snapshot ID without path separators.",
      ),
    );
  }
  return Effect.scoped(
    Effect.gen(function* () {
      const archivePath = yield* snapshotArchivePath(deps.paths, info);
      yield* persistVerifiedStream({
        body: Stream.fromReadableStream({
          evaluate: () => Bun.file(archivePath).stream(),
          onError: (cause) => cause,
        }),
        destinationPath: destPath,
        expectedSha256: info.digest,
        expectedSizeBytes: info.sizeBytes,
        mode: 0o600,
      });
    }).pipe(
      mapFailures((cause) =>
        sqliteSnapshotCatalogFailure(service, "Cannot read a verified SQLite snapshot archive.", cause),
      ),
    ),
  );
};
